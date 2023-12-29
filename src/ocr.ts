import { type ImageLike, createScheduler, type Bbox, createWorker, Scheduler, RecognizeResult, Word, Line, Rectangle } from "tesseract.js";
import { closest, distance } from 'fastest-levenshtein';
import { OCRPreprocessMessageInput, OCRPreprocessMessageOutput } from "./preprocess.worker";
import { getDocument, GlobalWorkerOptions } from "pdfjs-dist";
// If you're bundling pdf.js along with the rest of the code, the worker needs to be loaded so that the bundler is aware of it.
import 'pdfjs-dist/build/pdf.worker.min.mjs';

function copyImageData(data: ImageData): HTMLCanvasElement {
  const tempCanvas = document.createElement("canvas");
  tempCanvas.width = data.width;
  tempCanvas.height = data.height;
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

function pad0(num: number): string {
  return (num < 10 ? `0${num}` : num.toString());
}

type OCRTarget = {
  bbox: Bbox;
  isDate?: boolean;
  corrector?: ((value: string, history: string[] | undefined) => string | null) | boolean;
}
type OCRTargetReadResult = { text: string, confidence: number };

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
  /** The recommended width of the passport view area. Larger sizes mean that the font would be clearer, but the OCR would take a longer time to finish processing. */
  recommendedWidth: number;
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
        y1: 0.230,
      },
      corrector: PassportOCR.correctPassportNumber,
    } as OCRTarget,
    fullName: {
      bbox: {
        x0: 0.000,
        y0: 0.230,
        x1: 0.820,
        y1: 0.350,
      },
      corrector: PassportOCR.correctAlphabet,
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
  _numberScheduler: Scheduler | undefined;
  options: PassportOCROptions;
  constructor(options?: Partial<PassportOCROptions>) {
    this.canvas = document.createElement("canvas");
    this.getScheduler();
    this.getNumberScheduler();
    this.options = {
      onProcessImage: options?.onProcessImage,
      history: options?.history ?? Object.create(null),
      historyLimit: options?.historyLimit ?? 10,
      recommendedWidth: options?.recommendedWidth ?? 960,
    };
  }

  /** Corrects passport dates. Day and year must be numbers, but there's a loose word comparison for the month part. */
  private static correctPassportDate(value: string): string | null {
    // Sometimes, letters in the month part are interpreted as digits (O <=> 0) so we cannot simply use \w.
    const match = value.match(/([0-9]{1,2})\s*([\d\w]{3})\s*([0-9]{4})/);
    if (!match) return null;
    const day = parseInt(match[1]);
    const rawMonth = match[2].toUpperCase();
    const year = parseInt(match[3]);
    const closestMonth = closest(rawMonth, PassportOCR.MONTHS);
    const month = distance(rawMonth, closestMonth) <= 2 ? closestMonth : null;
    if (isNaN(day) || isNaN(year) || !month) {
      return null;
    }
    if (day < 1 || day > 31 || year < 1900 || year > 2200) {
      return null;
    }
    return `${pad0(day)} ${month} ${year}`;
  }

  private static correctPassportNumber(value: string) {
    return Array.from(value.toUpperCase()).filter(chr => {
      const ascii = chr.charCodeAt(0);
      const isNumeric = 48 <= ascii && ascii <= 48 + 9;
      const isUppercaseAlpha = 65 <= ascii && ascii <= 65 + 26;
      return isNumeric || isUppercaseAlpha;
    }).join('').substring(0, 8);
  }
  private static correctAlphabet(value: string) {
    return Array.from(value.toUpperCase()).filter(chr => {
      const ascii = chr.charCodeAt(0);
      return 65 <= ascii && ascii <= 65 + 26;
    }).join('');
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
    const WORKER_COUNT = 3;
    const scheduler = await createScheduler();
    const promisedWorkers = Array.from({ length: WORKER_COUNT }, async (_, i) => {
      const worker = await createWorker("ind", undefined, undefined, {
        // https://github.com/tesseract-ocr/tessdoc/blob/main/ImproveQuality.md
        // Most words are not dictionary words; numbers should be treated as digits
        load_system_dawg: '0',
        load_freq_dawg: '0',
        load_number_dawg: '0',
      });
      await worker.setParameters({
        tessedit_char_blacklist: `,."'“`
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

  private async getNumberScheduler(): Promise<Scheduler> {
    if (this._numberScheduler !== undefined) {
      return this._numberScheduler;
    }
    const WORKER_COUNT = 2;
    const scheduler = await createScheduler();
    const promisedWorkers = Array.from({ length: WORKER_COUNT }, async () => {
      const worker = await createWorker("ind", undefined, undefined, {
        load_system_dawg: '0',
        load_freq_dawg: '0',
        load_number_dawg: '0',
      });
      // This scheduler will only track numbers
      await worker.setParameters({
        tessedit_char_whitelist: '0123456789',
      });
      return worker;
    });
    const workers = await Promise.all(promisedWorkers);
    for (const worker of workers) {
      scheduler.addWorker(worker);
    }
    this._numberScheduler = scheduler;
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
    const viewport = firstPage.getViewport({
      scale: 1,
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
    const tempCanvas = copyImageData(ctx.getImageData(0, 0, this.canvas.width, this.canvas.height));
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
  }): Promise<OCRTargetReadResult | null> {
    const ctx = canvas.getContext('2d', {
      willReadFrequently: true,
    })!;
    this.rotateCanvas(pivot, canvas);
    this.cropCanvas(box, 0, canvas);
    this.scaleCanvasToRecommendedSize({
      canvas,
      recommendedWidth: 300,
    });
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

    const processedLine = this.processLine("passportNumber", line);
    return processedLine ? {
      text: processedLine,
      confidence: line.confidence,
    } : null;
  }

  /** Given a relative rectangle, find the rectangle position on the canvas */
  private getCanvasRectFromRelativeRect(bbox: Bbox): Rectangle {
    const width = (bbox.x1 - bbox.x0) * this.canvas.width;
    const height = (bbox.y1 - bbox.y0) * this.canvas.height;
    const left = bbox.x0 * this.canvas.width;
    const top = bbox.y0 * this.canvas.height;
    return { left, top, width, height };
  }

  /** Separates a date target rectangle into three sections for day month and year */
  private getDateTargetRectangles(target: OCRTarget): Rectangle[] {
    const fullRect = this.getCanvasRectFromRelativeRect(target.bbox);

    const isPositionedAtLeftSide = target.bbox.x1 <= 0.5;
    const sections: Rectangle[] = [undefined, undefined, undefined] as any;
    if (isPositionedAtLeftSide) {
      const relativeSections = [0.23, 0.32, 0.45];
      let cumulative = 0;
      for (let i = 0; i < relativeSections.length; i++) {
        const percentage = relativeSections[i];
        sections[i] = {
          ...fullRect,
          left: fullRect.left + fullRect.width * cumulative,
          width: fullRect.width * percentage,
        }
        cumulative += percentage;
      }
    } else {
      const relativeSections = [0.4, 0.3, 0.3];
      let cumulative = 1;
      for (let i = 0; i < relativeSections.length; i++) {
        const percentage = relativeSections[i];
        sections[i] = {
          ...fullRect,
          left: fullRect.left + fullRect.width - fullRect.width * cumulative,
          width: fullRect.width * percentage,
        }
        cumulative -= percentage;
      }
    }
    return sections;
  }

  private async readDateTarget(scheduler: Scheduler, key: keyof typeof PassportOCR.targets, target: OCRTarget, imgUrl: string): Promise<OCRTargetReadResult | null> {
    const sections = this.getDateTargetRectangles(target);
    const numberScheduler = await this.getNumberScheduler();
    const [day, month, year] = (await Promise.all([
      numberScheduler.addJob("recognize", imgUrl, {
        rectangle: sections[0],
      }),
      scheduler.addJob("recognize", imgUrl, {
        rectangle: sections[1]
      }),
      numberScheduler.addJob("recognize", imgUrl, {
        rectangle: sections[2],
      }),
    ])).map(result => {
      const line = result.data.lines[0];
      return line ? {
        text: line.text.trim(),
        confidence: line.confidence,
      } : null;
    });

    const processedLine = !!day && !!month && !!year ? this.processLine(key, `${day.text} ${month.text} ${year.text}`) : null;
    return processedLine ? {
      text: processedLine,
      confidence: (day!.confidence + month!.confidence + year!.confidence) / 3
    } : null;
  }

  /** Perform OCR on a target. ``imgUrl`` can be retrieved from ``this.canvas.toDataURL()`` */
  private async readTarget(scheduler: Scheduler, key: keyof typeof PassportOCR.targets, target: OCRTarget, imgUrl: string): Promise<OCRTargetReadResult | null> {
    const rectangle = this.getCanvasRectFromRelativeRect(target.bbox);

    // With rectangle, we don't need to make explicit copies of the image. The same image can be passed to the scheduler.
    const [result, altResult] = await Promise.all([
      scheduler.addJob("recognize", imgUrl, {
        rectangle
      }),
      // Also perform a redundant check by splitting the date into three for potentially better recognition
      target.isDate ? this.readDateTarget(scheduler, key, target, imgUrl) : null
    ]);
    // Greedily grab the first line and hope for the best.
    const line = result.data.lines[0];
    const processedLine = line ? this.processLine(key, line) : null;

    // Compare the confidence of the alternative result with this result.
    if (altResult && altResult.confidence > line.confidence) {
      return altResult;
    }
    return processedLine ? { text: processedLine, confidence: line.confidence } : null;
  }

  /** For debug purposes. Mark the target boxes on the canvas */
  private async markBoxes(boxes: Rectangle[]) {
    const ctx = this.canvasContext;
    ctx.strokeStyle = "green"
    for (const box of boxes) {
      ctx.strokeRect(box.left, box.top, box.width, box.height);
    }
  }

  /** Processes a line outputted by the OCR.
   *  If the original target has a corrector function, the corrector function will be invoked.
   *  If it is a truthy value, the line will be compared with similar entries in its history to find the closest match.
   *  Otherwise, the original line is returned.
   */
  private processLine(key: keyof typeof PassportOCR.targets, line: Line | string) {
    let text: string | null = typeof line === 'string' ? line : line.text.trim();
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

  /** Tesseract seems to perform better when the text is bigger. This would increase the amount of time for OCR,
   *  but at the very least, small images can now be recognized properly. */
  private scaleCanvasToRecommendedSize(options: {
    canvas?: HTMLCanvasElement;
    recommendedWidth?: number;
    // If the width exceeds recommendedWidth, should the image be downscaled or not
    shouldDownscale?: boolean;
  }) {
    let { canvas, recommendedWidth, shouldDownscale = true } = options;
    canvas = canvas ?? this.canvas;
    recommendedWidth = recommendedWidth ?? this.options.recommendedWidth
    if (canvas.width > recommendedWidth && !shouldDownscale) {
      return;
    }

    const scaleFactor = recommendedWidth / canvas.width;
    const ctx = canvas.getContext('2d', {
      willReadFrequently: true,
    })!;
    const imageCopy = copyImageData(ctx.getImageData(0, 0, canvas.width, canvas.height));
    canvas.width = recommendedWidth;
    canvas.height = canvas.height * scaleFactor;
    ctx.drawImage(imageCopy, 0, 0, canvas.width, canvas.height);
  }

  /** Performs OCR */
  async run(): Promise<PassportOCRPayload> {
    this.scaleCanvasToRecommendedSize({
      recommendedWidth: 1400,
    });
    const getPassportNumberAlt = await this.locateViewArea();
    const scheduler = await this.getScheduler();
    this.scaleCanvasToRecommendedSize({});

    const result: Record<string, OCRTargetReadResult | null> = {};
    const imgUrl = this.canvas.toDataURL();

    const promises: Promise<unknown>[] = Object.keys(PassportOCR.targets).map(async (k) => {
      const key = k as keyof typeof PassportOCR.targets;
      const value = PassportOCR.targets[key];
      result[key] = await this.readTarget(scheduler, key, value, imgUrl);
    });
    promises.push(new Promise<void>(async (resolve) => {
      result.passportNumber2 = await getPassportNumberAlt();
      resolve();
    }));
    await Promise.all(promises);

    // Compare passport number and its alternative fetched from passport bottom
    if ((!result.passportNumber && result.passportNumber2) || (result.passportNumber && result.passportNumber2 && result.passportNumber.confidence <= result.passportNumber2.confidence)) {
      result.passportNumber = result.passportNumber2;
    }
    // Same goes to sex. Sex can either be located to the top right, or at the center between date of birth and place of birth.
    if (
      (!result.sex && result.sex2) ||
      (result.sex && result.sex2 && result.sex.confidence < result.sex2.confidence)) {
      result.sex = result.sex2;
    }
    delete result.sex2;
    delete result.passportNumber2;

    // Mark bounding boxes
    const boxes: Rectangle[] = [];
    for (const key of Object.keys(PassportOCR.targets)) {
      const target = PassportOCR.targets[key as keyof typeof PassportOCR.targets];
      if (target.isDate) {
        boxes.push(...this.getDateTargetRectangles(target));
      }
      boxes.push(this.getCanvasRectFromRelativeRect(target.bbox));
    }
    this.markBoxes(boxes);
    await this.debugImage();

    // Extract only the text as returned data
    const payload: Record<string, string | null> = {};
    for (const key of Object.keys(result)) {
      const value = result[key];
      payload[key] = value ? value.text : null;
    }

    return payload as PassportOCRPayload;
  }

  /** Cleans up all existing workers. Make sure to call this function when the page is closed */
  async terminate() {
    await this._scheduler?.terminate();
    await this._numberScheduler?.terminate();
  }
}