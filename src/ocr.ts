import { type ImageLike, createScheduler, type Bbox, createWorker, Scheduler, RecognizeResult, Word, Line } from "tesseract.js";
import { closest, distance } from 'fastest-levenshtein';
import { OCRPreprocessMessageInput, OCRPreprocessMessageOutput } from "./preprocess.worker";
import { getDocument, GlobalWorkerOptions } from "pdfjs-dist";
// If you're bundling pdf.js along with the rest of the code, the worker needs to be loaded so that the bundler is aware of it.
import 'pdfjs-dist/build/pdf.worker.min.mjs';

function copyImageData(data: ImageData, width: number, height: number): HTMLCanvasElement {
  const tempCanvas = document.createElement("canvas");
  tempCanvas.width = width;
  tempCanvas.height = height;
  const tempCtx = tempCanvas.getContext('2d')!;
  tempCtx.putImageData(data, 0, 0);
  return tempCanvas;
}

function runWorker<TInput, TOutput>(worker: Worker, input: TInput, transfer?: Transferable[]): Promise<TOutput> {
  return new Promise<TOutput>((resolve, reject) => {
    worker.onmessage = (e) => resolve(e.data as TOutput);
    worker.onerror = reject;
    worker.postMessage(input, transfer || []);
  });
}

function median(arr: number[]) {
  if (arr.length % 2 === 0) {
    return (arr[arr.length / 2 - 1] + arr[arr.length / 2]) / 2;
  } else {
    return arr[Math.floor(arr.length / 2)];
  }
}

type OCRTarget = {
  bbox: Bbox;
  isDate?: boolean;
  corrector?: ((value: string, history: string[] | undefined) => string | null) | boolean;
}

export type PassportOCRPayload = {
  [key in keyof typeof PassportOCR.targets]: string | null;
};
export type PassportOCRHistory = {
  [key in keyof typeof PassportOCR.targets]?: string[];
}

interface PassportOCROptions {
  /** Callback for debugging */
  onProcessImage?: (objectUrl: string) => void | Promise<void>;
  /** An object containing previous manually corrected values */
  history: PassportOCRHistory;
  /** How many history entries should be stored at a time */
  historyLimit: number;
}

/** Helper class to perform OCR for passports.
 * 
 *  The recommended flow is: ``mountFile`` (to locate the relevant passport section) -> ``run`` (perform OCR) -> ...repeat... -> ``terminate`` (after you're done)
 *  
 *  Note that ``mountFile`` and ``run`` mutates the state of the canvas. It is recommended that if an error occurs, you should repeat from the ``mountFile`` stage. */
export default class PassportOCR {
  /** Bounding boxes for targetting relevant sections in the passport. */
  static targets = {
    type: {
      bbox: {
        x0: 0.000,
        y0: 0.060,
        x1: 0.230,
        y1: 0.200,
      },
      corrector: PassportOCR.correctPassportType,
    } as OCRTarget,
    countryCode: {
      bbox: {
        x0: 0.240,
        y0: 0.060,
        x1: 0.560,
        y1: 0.200
      },
      corrector: true,
    } as OCRTarget,
    passportNumber: {
      bbox: {
        x0: 0.600,
        y0: 0.060,
        x1: 1,
        y1: 0.200,
      },
    } as OCRTarget,
    fullName: {
      bbox: {
        x0: 0.000,
        y0: 0.230,
        x1: 0.820,
        y1: 0.350,
      },
    } as OCRTarget,
    sex: {
      bbox: {
        x0: 0.820,
        y0: 0.230,
        x1: 1,
        y1: 0.350,
      },
      corrector: PassportOCR.correctSex,
    } as OCRTarget,
    nationality: {
      bbox: {
        x0: 0.000,
        y0: 0.380,
        x1: 0.780,
        y1: 0.520,
      },
      corrector: true,
    } as OCRTarget,
    dateOfBirth: {
      bbox: {
        x0: 0.000,
        y0: 0.540,
        x1: 0.350,
        y1: 0.680,
      },
      isDate: true,
      corrector: PassportOCR.correctPassportDate,
    } as OCRTarget,
    sex2: {
      bbox: {
        x0: 0.360,
        y0: 0.540,
        x1: 0.540,
        y1: 0.680,
      },
      corrector: PassportOCR.correctSex,
    } as OCRTarget,
    placeOfBirth: {
      bbox: {
        x0: 0.560,
        y0: 0.540,
        x1: 1,
        y1: 0.680
      },
      corrector: true,
    } as OCRTarget,
    dateOfIssue: {
      bbox: {
        x0: 0.000,
        y0: 0.700,
        x1: 0.350,
        y1: 0.840,
      },
      isDate: true,
      corrector: PassportOCR.correctPassportDate,
    } as OCRTarget,
    dateOfExpiry: {
      bbox: {
        x0: 0.640,
        y0: 0.700,
        x1: 1,
        y1: 0.840,
      },
      isDate: true,
      corrector: PassportOCR.correctPassportDate,
    } as OCRTarget,
    regNumber: {
      bbox: {
        x0: 0.000,
        y0: 0.860,
        x1: 0.500,
        y1: 1,
      },
    } as OCRTarget,
    issuingOffice: {
      bbox: {
        x0: 0.500,
        y0: 0.860,
        x1: 1,
        y1: 1,
      },
      corrector: true,
    } as OCRTarget
  };
  static MONTHS = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];

  /** This can be attached to a DOM tree for debugging purposes. All painting operations to process images for OCR will be performed on this. */
  canvas: HTMLCanvasElement;
  /** The Tesseract Scheduler used to perform OCR tasks. Prefer using getScheduler as there's no guarantee that ``_scheduler`` is initialized when you use it. */
  _scheduler: Scheduler | undefined;
  options: PassportOCROptions;
  constructor(options?: Partial<PassportOCROptions>) {
    this.canvas = document.createElement("canvas");
    this.getScheduler();
    this.options = {
      onProcessImage: options?.onProcessImage,
      history: options?.history ?? Object.create(null),
      historyLimit: options?.historyLimit ?? 10,
    };
  }

  /** Corrects passport dates. Day and year must be numbers, but there's a loose word comparison for the month part. */
  private static correctPassportDate(value: string): string | null {
    // Sometimes, letters in the month part are interpreted as digits (O <=> 0) so we cannot simply use \w.
    const match = value.match(/([0-9]{2})\s*([\d\w]{3})\s*([0-9]{4})/);
    if (!match) return null;
    const day = match[1];
    const rawMonth = match[2];
    const year = match[3];
    const month = closest(rawMonth, PassportOCR.MONTHS);
    if (isNaN(parseInt(day, 10)) || isNaN(parseInt(year, 10))) {
      return null;
    }
    return `${day} ${month} ${year}`;
  }

  /** Corrects passport types.
   * 
   *  If the passport type is a capital letter then it is returned, but if it isn't, null. */
  private static correctPassportType(value: string) {
    if (!value) return null;
    let type: string | undefined;
    for (const chr of value.toUpperCase()) {
      const ascii = chr.charCodeAt(0);
      if (65 <= ascii && ascii <= 65 + 26) {
        type = chr;
        break;
      }
    }
    if (type) {
      return type;
    }
    return null;
  }

  /** Corrects sex values outputted by the OCR. Values should be formatted as AA or A/A to be valid. */
  private static correctSex(value: string, history: string[] | undefined) {
    if (!value) return null;
    const match = value.toUpperCase().match(/([A-Z])\/*([A-Z])/);
    if (!match) return null;
    let sex = `${match[1]}/${match[2]}`;
    if (history && history.length > 0) {
      const closestMatch = closest(sex, history);
      if (distance(sex, closestMatch) <= 1) {
        sex = closestMatch;
      }
    }
    return sex;
  }

  private async debugImage(imageUrl?: string, wait?: number) {
    if (this.options.onProcessImage) {
      await this.options.onProcessImage(imageUrl || this.canvas.toDataURL());
      if (wait) {
        await new Promise((resolve) => setTimeout(resolve, wait));
      }
    }
  }
  private async getScheduler(): Promise<Scheduler> {
    if (this._scheduler !== undefined) {
      return this._scheduler;
    }
    const WORKER_COUNT = 4;
    const scheduler = await createScheduler();
    const promisedWorkers = Array.from({ length: WORKER_COUNT }, async (_, i) => {
      const worker = await createWorker("ind", undefined, undefined, {
        // https://github.com/tesseract-ocr/tessdoc/blob/main/ImproveQuality.md
        // Most words are not dictionary words; numbers should be treated as digits
        load_system_dawg: '0',
        load_freq_dawg: '0',
        load_number_dawg: '0',
      });
      return worker;
    });
    const workers = await Promise.all(promisedWorkers);
    for (const worker of workers) {
      scheduler.addWorker(worker);
    }
    this._scheduler = scheduler;
    return scheduler;
  }

  /** Consider using this rather than manually calling ``this.canvas.getContext`` as this also sets willReadFrequently to true, allowing for quicker image data fetching. */
  get canvasContext(): CanvasRenderingContext2D {
    return this.canvas.getContext("2d", {
      willReadFrequently: true,
    })!;
  }
  clearCanvas() {
    this.canvasContext.clearRect(0, 0, this.canvas.width, this.canvas.height);
  }

  /** Helper method for finding words in a line. The words don't have to exactly match, as long as they are close enough. */
  private static findWordsInLine(line: Line, words: string[]): Record<string, Word> {
    const tracker = Object.create(null);
    const insensitiveWords = words.map(word => word.toLowerCase());
    for (let word of line.words) {
      for (let matchWord of insensitiveWords) {
        if (
          !tracker[matchWord] &&
          distance(word.text.toLowerCase(), matchWord.toLowerCase()) < Math.floor(matchWord.length / 2)) {
          tracker[matchWord] = word;
        }
      }
      if (Object.keys(tracker).length === words.length) {
        break;
      }
    }
    return tracker;
  }

  private rotateCanvas(pivot: { x: number, y: number, angle: number }, targetCanvas?: HTMLCanvasElement) {
    const canvas = targetCanvas ?? this.canvas;
    const ctx = targetCanvas ? targetCanvas.getContext('2d', {
      willReadFrequently: true
    })! : this.canvasContext;

    const tempCanvas = document.createElement("canvas");
    tempCanvas.width = canvas.width;
    tempCanvas.height = canvas.height;
    const tempCtx = tempCanvas.getContext('2d', {
      willReadFrequently: true,
    })!;
    tempCtx.translate(-pivot.x, -pivot.y);
    tempCtx.rotate(-pivot.angle);
    tempCtx.drawImage(canvas, pivot.x, pivot.y);
    tempCtx.translate(pivot.x, pivot.y);
    tempCtx.resetTransform();

    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(tempCanvas, 0, 0);
  }

  /** Mutates ``targetCanvas`` with the cropped image. If no ``targetCanvas`` is provided, the canvas element used for OCR will be used instead. */
  private cropCanvas(box: Bbox, angle: number, targetCanvas?: HTMLCanvasElement): ImageData {
    const width = box.x1 - box.x0;
    const height = box.y1 - box.y0;
    const canvas = targetCanvas ?? this.canvas;
    const ctx = targetCanvas ? targetCanvas.getContext('2d', {
      willReadFrequently: true
    })! : this.canvasContext;
    const tempCanvas = document.createElement("canvas");
    tempCanvas.width = canvas.width;
    tempCanvas.height = canvas.height;
    const tempCtx = tempCanvas.getContext('2d', {
      willReadFrequently: true,
    })!;
    tempCtx.translate(-box.x0, -box.y0);
    tempCtx.rotate(-angle);
    tempCtx.drawImage(canvas, 0, 0);

    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(tempCanvas, 0, 0);
    const cropped = ctx.getImageData(0, 0, width, height);
    ctx.resetTransform();
    canvas.width = width;
    canvas.height = height;
    ctx.putImageData(cropped, 0, 0);
    return cropped;
  }

  async mountImageFile(file: File) {
    // Load the image
    // https://stackoverflow.com/questions/32272904/converting-blob-file-data-to-imagedata-in-javascript
    const fileUrl = URL.createObjectURL(file);
    const image = new Image();
    image.src = fileUrl;
    await new Promise<void>((resolve, reject) => {
      image.onload = () => {
        this.canvas.width = image.width;
        this.canvas.height = image.height;
        URL.revokeObjectURL(fileUrl);
        resolve();
      }
      image.onerror = reject;
    });
    const ctx = this.canvasContext;
    ctx.drawImage(image, 0, 0);
  }
  async mountPdfFile(file: File) {
    const pdf = await getDocument(await file.arrayBuffer()).promise;
    const firstPage = await pdf.getPage(1);
    // Sometimes, the passport is really small in the pdf file. By increasing the scale of the pdf file, the text should hopefully be more legible.
    const viewport = firstPage.getViewport({
      scale: 1.5,
    });
    this.canvas.width = viewport.width;
    this.canvas.height = viewport.height;
    await firstPage.render({
      canvasContext: this.canvasContext,
      viewport,
    }).promise;
  }

  /** Locate the section of the image which contain the relevant information. This function will mutate the canvas. */
  private async locateViewArea() {
    const scheduler = await this.getScheduler();
    const ctx = this.canvasContext;
    const oldImageData = ctx.getImageData(0, 0, this.canvas.width, this.canvas.height);
    const p0 = await this.locateViewAreaTop(scheduler, ctx);
    const viewRect = {
      x0: p0.x,
      y0: p0.y,
      x1: p0.x + p0.width,
      y1: p0.y + p0.height,
      angle: p0.angle,
    }

    {
      // Translate is so that we can set the pivot point of the rotation to the top-left corner of the anchor.
      // Note that this is just to draw a rectangle for debugging purposes. Feel free to remove this to save cycles.
      ctx.translate(viewRect.x0, viewRect.y0);
      ctx.rotate(p0.angle);
      ctx.strokeStyle = "green";
      ctx.strokeRect(0, 0, viewRect.x1 - viewRect.x0, viewRect.y1 - viewRect.y0);
      ctx.resetTransform();
      await this.debugImage();
    }
    ctx.putImageData(oldImageData, 0, 0);

    // Backup original image
    const tempCanvas = copyImageData(ctx.getImageData(0, 0, this.canvas.width, this.canvas.height), this.canvas.width, this.canvas.height);
    this.cropCanvas(viewRect, viewRect.angle);
    await this.debugImage();
    const p1 = await this.locateViewAreaBottom(scheduler, ctx);
    const oldImageData2 = ctx.getImageData(0, 0, this.canvas.width, this.canvas.height);

    {
      // Also for debug purposes. We assume that locateViewAreaTop has successfully identified the angle of the passport.
      ctx.strokeStyle = "green";
      ctx.strokeRect(0, 0, p1.x, p1.y);
      await this.debugImage();
    }
    this.canvas.width = p1.x;
    this.canvas.height = p1.y;
    ctx.putImageData(oldImageData2, 0, 0);
    await this.debugImage();

    // bad code but who cares
    // Passport number can be retrieved from the bottom-left section of the passport, but that part is cropped off after ``locateViewAreaTop``.
    // To locate said section, we also need p1.y to mark the baseline.
    // Because of those two reasons, we have to capture p0 and p1 in a closure. This closure will then be called when running the OCR.
    return () => {
      const endHeight = p1.endY1 - p1.endY0;
      return this.getPassportNumberAlternative(scheduler, tempCanvas, {
        x0: Math.max(0, p0.x - (p0.wordWidth * 0.9)),
        x1: p0.x,
        // add some padding
        y0: p1.endY0 + p0.y - endHeight * 0.5,
        y1: p1.endY1 + p0.y + endHeight * 0.5,
      }, {
        x: p0.x,
        y: p1.y,
        angle: p0.angle,
      });
    };
  }

  private async locateViewAreaTop(scheduler: Scheduler, ctx: CanvasRenderingContext2D) {
    const imageData = ctx.getImageData(0, 0, this.canvas.width, this.canvas.height);
    // This is tested using Vite and should also work with Webpack 5. If it doesn't, perhaps find a web worker module loader? 
    const worker = new Worker(new URL("./locator.worker.ts", import.meta.url), { type: 'module' });
    const procImage = await runWorker<OCRPreprocessMessageInput, OCRPreprocessMessageOutput>(worker, {
      width: imageData.width,
      height: imageData.height,
      data: imageData.data,
      // Second parameter is of Transferable data types. Since ``imageData.data.buffer`` is an ArrayBuffer, it can be transferred over to the web worker rather than copied.
      // That also means that imageData.data can no longer be used in this scope.
    }, [imageData.data.buffer]);
    ctx.putImageData(new ImageData(procImage, imageData.width, imageData.height), 0, 0);
    const imageUrl = this.canvas.toDataURL();
    await this.debugImage(imageUrl);

    const result = await scheduler.addJob("recognize", imageUrl);

    // Find any of these words (note that republik and indonesia must both appear in the same line)
    let republikWord: Word | undefined, indonesiaWord: Word | undefined, pasporWord: Word | undefined;
    for (const line of result.data.lines) {
      const { republik, indonesia, paspor } = PassportOCR.findWordsInLine(line, ["republik", "indonesia", "paspor"]);
      if (republik && indonesia) {
        republikWord = republik;
        indonesiaWord = indonesia;
        break;
      }
      if (paspor && !pasporWord) {
        pasporWord = paspor;
      }
    }

    // SCENARIO #1: REPUBLIK INDONESIA is found. x0 is always aligned with relevant section.
    if (republikWord && indonesiaWord) {
      const width = (indonesiaWord.bbox.x1 - republikWord.bbox.x0);
      const republikWidth = (republikWord.bbox.x1 - republikWord.bbox.x0);

      // Since "Republik" and "Indonesia" is supposed to be aligned, we can calculate how much the passport is rotated
      const angle = Math.atan2(
        ((indonesiaWord.bbox.y0 - republikWord.bbox.y0) + (indonesiaWord.bbox.y1 - republikWord.bbox.y1)) / 2 / this.canvas.height,
        (indonesiaWord.bbox.x1 - republikWord.bbox.x0) / this.canvas.width);

      return {
        x: republikWord.bbox.x0 - republikWidth * 0.1,
        // Don't use y1 since it can extend to the "Republic of Indonesia" subtitle. Height is also influenced by this
        y: republikWord.bbox.y0 + (republikWidth * 0.3),
        // Predicted width and height. This doesn't have to be accurate, but just enough so that locateViewAreaBottom can find the last two lines in the passport.
        width: width * 2.2,
        height: width * 2.2,
        wordWidth: width,
        angle,
      }
    }
    // SCENARIO #2: REPUBLIK INDONESIA is blocked for some reason, but PASPOR is found. y1 is always aligned with relevant section.
    if (pasporWord) {
      const width = (pasporWord.bbox.x1 - pasporWord.bbox.x0);
      const height = (pasporWord.bbox.y1 - pasporWord.bbox.y0);
      return {
        x: pasporWord.bbox.x1 + (width * 0.75),
        y: pasporWord.bbox.y1 - (height * 0.5),
        width: width * 3 * 2,
        height: width * 3 * 2,
        wordWidth: width * 3,
        // There's nothing to compare the "Paspor" word with, so uh, cowabunga.
        angle: 0
      }
    }

    throw new Error("Cannot find top-left end of passport");
  }

  /** Locate the bottom part of the passport, that being the identification numbers below the '<<<<<<<'.
   * 
   *  Note that Tesseract can hardly identify '<<<<<<' sequences (instead outputting gibberish),
   *  which is why the bottom part of the passport is tracked by counting the digits on a line.
   */
  private async locateViewAreaBottom(scheduler: Scheduler, ctx: CanvasRenderingContext2D) {
    const imageData = ctx.getImageData(0, 0, this.canvas.width, this.canvas.height);
    // Run the preprocessing step. This will mutate the canvas for the rest of the OCR step. Keep that in mind if bugs happen.
    const preprocessWorker = new Worker(new URL("./preprocess.worker.ts", import.meta.url), { type: 'module' });
    const procImage = await runWorker<OCRPreprocessMessageInput, OCRPreprocessMessageOutput>(preprocessWorker, {
      width: imageData.width,
      height: imageData.height,
      data: imageData.data,
    }, [imageData.data.buffer]);
    ctx.putImageData(new ImageData(procImage, imageData.width, imageData.height), 0, 0);
    await this.debugImage();

    const result = await scheduler.addJob("recognize", this.canvas.toDataURL());

    let endOfPassport = -1;
    let endOfPassportLine: Line | undefined;
    // Find the line with the most digits (that's probably the bottom-most line in the passport)
    for (let i = 0; i < result.data.lines.length; i++) {
      const line = result.data.lines[i];
      let numberCount = 0;
      for (const chr of line.text) {
        const ascii = chr.charCodeAt(0);
        if (48 <= ascii && ascii <= 48 + 9) {
          numberCount++;
        }
      }
      if (numberCount > 8) {
        // No short circuiting. We want to get the latest line since there's a possibility that "No. Reg" contains enough numbers to fulfill the condition.
        endOfPassport = i;
        endOfPassportLine = line;
      }
    }

    if (endOfPassport === -1 || !endOfPassportLine) {
      throw new Error("Cannot find bottom-right end of passport");
    }

    // Get 6 lines above the '<<<<<'
    const relevantLines = result.data.lines.slice(Math.max(endOfPassport - 7, 0), endOfPassport - 1);
    // Get the median of the leftmost edge (x1) of all lines. This will be the representative x value.
    const rightEdges = relevantLines.slice(Math.max(0, relevantLines.length - 3), relevantLines.length).map(x => x.bbox.x1);
    rightEdges.sort((a, b) => a - b);
    const rightEdgesMedian = median(rightEdges);

    return {
      x: rightEdgesMedian,
      y: relevantLines[relevantLines.length - 1].bbox.y1,
      endY0: endOfPassportLine.bbox.y0,
      endY1: endOfPassportLine.bbox.y1,
    }
  }

  /** Alternative way of fetching passport number
   *  Due to the reflective garuda picture near the passport number, the passport number tends to be obscured by reflection when its photo is taken.
   *  Fortunately, passport number can also be fetched from the bottommost line on the passport.
   *  Unfortunately, our cropping mechanism will cut that part out of the view section, which is why both box and pivot needs to be provided for rotation and cropping.
   */
  private async getPassportNumberAlternative(scheduler: Scheduler, canvas: HTMLCanvasElement, box: Bbox, pivot: {
    x: number,
    y: number,
    angle: number,
  }) {
    const ctx = canvas.getContext('2d', {
      willReadFrequently: true,
    })!;
    this.rotateCanvas(pivot, canvas);
    this.cropCanvas(box, 0, canvas);
    await this.debugImage(canvas.toDataURL());

    const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
    const preprocessWorker = new Worker(new URL("./preprocess.worker.ts", import.meta.url), { type: 'module' });
    const procImage = await runWorker<OCRPreprocessMessageInput, OCRPreprocessMessageOutput>(preprocessWorker, {
      width: imageData.width,
      height: imageData.height,
      data: imageData.data,
    }, [imageData.data.buffer]);
    ctx.putImageData(new ImageData(procImage, imageData.width, imageData.height), 0, 0);
    const imgUrl = canvas.toDataURL();
    await this.debugImage(imgUrl);

    const result = await scheduler.addJob("recognize", imgUrl);
    if (result.data.lines.length === 0) {
      return null;
    }
    const line = result.data.lines[result.data.lines.length - 1];
    return line;
  }

  /** Perform OCR on a target. ``imgUrl`` can be retrieved from ``this.canvas.toDataURL()`` */
  private async readTarget(scheduler: Scheduler, target: OCRTarget, imgUrl: string): Promise<Line | null> {
    const width = (target.bbox.x1 - target.bbox.x0) * this.canvas.width;
    const height = (target.bbox.y1 - target.bbox.y0) * this.canvas.height;
    const x = target.bbox.x0 * this.canvas.width;
    const y = target.bbox.y0 * this.canvas.height;

    // With rectangle, we don't need to make explicit copies of the image. The same image can be passed to the scheduler.
    const result = await scheduler.addJob("recognize", imgUrl, {
      rectangle: {
        left: x,
        top: y,
        width,
        height,
      }
    });
    // Greedily grab the first line and hope for the best.
    return result.data.lines[0] ?? null;
  }

  /** For debug purposes. Mark the target boxes on the canvas */
  private async markBoxes(boxes: Bbox[]) {
    const ctx = this.canvasContext;
    ctx.strokeStyle = "green"
    for (const box of boxes) {
      ctx.strokeRect(box.x0, box.y0, box.x1 - box.x0, box.y1 - box.y0);
    }
  }

  /** Processes a line outputted by the OCR.
   *  If the original target has a corrector function, the corrector function will be invoked.
   *  If it is a truthy value, the line will be compared with similar entries in its history to find the closest match.
   *  Otherwise, the original line is returned.
   */
  private processLine(key: keyof typeof PassportOCR.targets, line: Line) {
    let text: string | null = line.text.trim();
    const originalTarget = PassportOCR.targets[key];
    const history = this.options.history[key];
    if (typeof originalTarget.corrector === 'function') {
      text = originalTarget.corrector(text, history);
    } else if (!!originalTarget.corrector) {
      if (history && history.length > 0) {
        const candidate = closest(text, history);
        if (distance(text, candidate) < Math.ceil(text.length * 2 / 3)) {
          text = candidate;
        }
      }
    }
    return text;
  }

  /** Updates the history with the CORRECTED version of the payload. Call this function after an employee has verified passport contents.
   * 
   *  This step is optional. However, previous corrected words can be used to correct the output of the OCR.
   */
  updateHistory(payload: PassportOCRPayload): PassportOCRHistory {
    for (const rawKey of Object.keys(PassportOCR.targets)) {
      const key = rawKey as keyof typeof PassportOCR.targets;
      const targetCorrector = PassportOCR.targets[key].corrector;
      if (!targetCorrector) {
        continue;
      }
      const value = payload[key];
      if (!value) {
        continue;
      }

      let history = this.options.history[key];
      if (!history) {
        history = [];
        this.options.history[key] = history;
      }
      if (!history.find(word => word === value)) {
        history.push(value);
        if (history.length > this.options.historyLimit) {
          history.shift();
        }
      }
    }
    return this.options.history;
  }

  /** Performs OCR */
  async run(): Promise<PassportOCRPayload> {
    const getPassportNumberAlt = await this.locateViewArea();
    const scheduler = await this.getScheduler();

    const result: Record<string, Line | null> = {};
    const imgUrl = this.canvas.toDataURL();
    const promises = Object.keys(PassportOCR.targets).map(async (k) => {
      const key = k as keyof typeof PassportOCR.targets;
      const value = PassportOCR.targets[key];
      result[key] = await this.readTarget(scheduler, value, imgUrl);
    });

    promises.push(new Promise(async (resolve) => {
      const passnum = await getPassportNumberAlt();
      result.passportNumber2 = passnum ? {
        ...passnum,
        text: passnum.text.trim().substring(0, 8),
      } : null;
      resolve();
    }));
    await Promise.all(promises);
    console.log(result.passportNumber, result.passportNumber2);
    if ((!result.passportNumber && result.passportNumber2) || (result.passportNumber && result.passportNumber2 && result.passportNumber.confidence <= result.passportNumber2.confidence)) {
      result.passportNumber = result.passportNumber2;
    }
    if (
      (!result.sex && result.sex2) ||
      (result.sex && result.sex2 && result.sex.confidence < result.sex2.confidence)) {
      result.sex = result.sex2;
    }
    delete result.sex2;
    delete result.passportNumber2;

    this.markBoxes(Object.keys(PassportOCR.targets).map((key) => {
      const { bbox } = PassportOCR.targets[key as keyof typeof PassportOCR.targets];
      return ({
        x0: bbox.x0 * this.canvas.width,
        y0: bbox.y0 * this.canvas.height,
        x1: bbox.x1 * this.canvas.width,
        y1: bbox.y1 * this.canvas.height,
      });
    }));
    await this.debugImage();

    const payload: Record<string, string | null> = {};
    for (const key of Object.keys(result)) {
      const value = result[key];
      payload[key] = value ? this.processLine(key as keyof typeof PassportOCR.targets, value) : null;
    }

    return payload as PassportOCRPayload;
  }

  /** Cleans up all existing workers. Make sure to call this function when the page is closed */
  async terminate() {
    await this._scheduler?.terminate();
  }
}