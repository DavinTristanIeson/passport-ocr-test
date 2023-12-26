import { type ImageLike, createScheduler, type Bbox, createWorker, Scheduler, RecognizeResult, Word, Line } from "tesseract.js";
import { closest, distance } from 'fastest-levenshtein';
import { OCRPreprocessMessageInput, OCRPreprocessMessageOutput } from "./preprocess.worker";

function getObjectUrlOfImageData(data: ImageData, width: number, height: number): string {
  const tempCanvas = document.createElement("canvas");
  tempCanvas.width = width;
  tempCanvas.height = height;
  const tempCtx = tempCanvas.getContext('2d')!;
  tempCtx.putImageData(data, 0, 0);
  return tempCanvas.toDataURL();
}

function runWorker<TInput, TOutput>(worker: Worker, input: TInput, transfer?: Transferable[]): Promise<TOutput> {
  return new Promise<TOutput>((resolve, reject) => {
    worker.onmessage = (e) => resolve(e.data as TOutput);
    worker.onerror = reject;
    worker.postMessage(input, transfer || []);
  });
}

async function pause() {
  await new Promise((resolve) => setTimeout(resolve, 5000));
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
  corrector?: ((value: string) => string | null) | boolean;
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
export default class PassportOCR {
  /** Bounding boxes for targetting relevant sections in the passport. */
  static targets = {
    type: {
      bbox: {
        x0: 0.010,
        y0: 0.080,
        x1: 0.230,
        y1: 0.200,
      },
      corrector: PassportOCR.correctPassportType,
    } as OCRTarget,
    countryCode: {
      bbox: {
        x0: 0.240,
        y0: 0.080,
        x1: 0.560,
        y1: 0.200
      },
      corrector: true,
    } as OCRTarget,
    passportNumber: {
      bbox: {
        x0: 0.600,
        y0: 0.080,
        x1: 1,
        y1: 0.200,
      },
    } as OCRTarget,
    fullName: {
      bbox: {
        x0: 0.010,
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
      corrector: true,
    } as OCRTarget,
    nationality: {
      bbox: {
        x0: 0.010,
        y0: 0.380,
        x1: 0.780,
        y1: 0.500,
      },
      corrector: true,
    } as OCRTarget,
    dateOfBirth: {
      bbox: {
        x0: 0.010,
        y0: 0.540,
        x1: 0.350,
        y1: 0.660,
      },
      corrector: PassportOCR.correctPassportDate,
    } as OCRTarget,
    sex2: {
      bbox: {
        x0: 0.360,
        y0: 0.540,
        x1: 0.540,
        y1: 0.660,
      },
    } as OCRTarget,
    placeOfBirth: {
      bbox: {
        x0: 0.560,
        y0: 0.540,
        x1: 1,
        y1: 0.660
      },
      corrector: true,
    } as OCRTarget,
    dateOfIssue: {
      bbox: {
        x0: 0.010,
        y0: 0.700,
        x1: 0.350,
        y1: 0.820,
      },
      corrector: PassportOCR.correctPassportDate,
    } as OCRTarget,
    dateOfExpiry: {
      bbox: {
        x0: 0.640,
        y0: 0.700,
        x1: 1,
        y1: 0.820,
      },
      corrector: PassportOCR.correctPassportDate,
    } as OCRTarget,
    regNumber: {
      bbox: {
        x0: 0.010,
        y0: 0.880,
        x1: 0.500,
        y1: 1,
      },
    } as OCRTarget,
    issuingOffice: {
      bbox: {
        x0: 0.500,
        y0: 0.880,
        x1: 1,
        y1: 1,
      },
      corrector: true,
    } as OCRTarget
  };
  static MONTHS = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];

  canvas: HTMLCanvasElement;
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
  private static correctPassportDate(value: string): string | null {
    // Kadang-kadang huruf dalam bulan bisa disalah-interpretasikan menjadi digit.
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

  private static correctPassportType(value: string) {
    return value.length === 0 ? null : value[0].toUpperCase();
  }

  private async debugImage(imageUrl?: string) {
    if (this.options.onProcessImage) {
      await this.options.onProcessImage(imageUrl || this.canvas.toDataURL());
      // await pause();
    }
  }
  private async getScheduler(): Promise<Scheduler> {
    if (this._scheduler !== undefined) {
      return this._scheduler;
    }
    const WORKER_COUNT = 4;
    const scheduler = await createScheduler();
    const workers = await Promise.all(Array.from({ length: WORKER_COUNT }, async () => {
      const worker = await createWorker("ind", undefined, undefined, {
        // https://github.com/tesseract-ocr/tessdoc/blob/main/ImproveQuality.md
        // Most words are not dictionary words; numbers should be treated as digits
        load_system_dawg: '0',
        load_freq_dawg: '0',
        load_number_dawg: '0',
      });
      return worker;
    }));
    for (const worker of workers) {
      scheduler.addWorker(worker);
    }
    this._scheduler = scheduler;
    return scheduler;
  }
  get canvasContext(): CanvasRenderingContext2D {
    return this.canvas.getContext("2d", {
      willReadFrequently: true,
    })!;
  }
  clearCanvas() {
    this.canvasContext.clearRect(0, 0, this.canvas.width, this.canvas.height);
  }
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

  private cropCanvas(box: Bbox, angle: number): ImageData {
    const width = box.x1 - box.x0;
    const height = box.y1 - box.y0;
    const ctx = this.canvasContext;

    const tempCanvas = document.createElement("canvas");
    tempCanvas.width = this.canvas.width;
    tempCanvas.height = this.canvas.height;
    const tempCtx = tempCanvas.getContext('2d', {
      willReadFrequently: true,
    })!;
    tempCtx.translate(-box.x0, -box.y0);
    tempCtx.rotate(-angle);
    tempCtx.drawImage(this.canvas, 0, 0);

    ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    ctx.drawImage(tempCanvas, 0, 0);
    const cropped = ctx.getImageData(0, 0, width, height);
    ctx.resetTransform();
    this.canvas.width = width;
    this.canvas.height = height;
    ctx.putImageData(cropped, 0, 0);
    return cropped;
  }

  async mountFile(file: File) {
    // https://stackoverflow.com/questions/32272904/converting-blob-file-data-to-imagedata-in-javascript
    const fileUrl = URL.createObjectURL(file);
    const image = new Image();
    image.src = fileUrl;
    await new Promise<void>((resolve) => {
      image.onload = () => {
        this.canvas.width = image.width;
        this.canvas.height = image.height;
        URL.revokeObjectURL(fileUrl);
        resolve();
      }
    });
    const ctx = this.canvasContext;
    ctx.drawImage(image, 0, 0);

    await this.locateViewArea();
  }

  /** Mutates the canvas */
  private async locateViewArea() {
    const scheduler = await this.getScheduler();
    const ctx = this.canvasContext;
    const oldImageData = ctx.getImageData(0, 0, this.canvas.width, this.canvas.height);
    const p0 = await this.locateViewAreaTop(scheduler, ctx);
    const viewRect = {
      x0: p0.x,
      y0: p0.y,
      x1: this.canvas.width,
      y1: this.canvas.height,
      angle: p0.angle,
    }

    {
      ctx.translate(viewRect.x0, viewRect.y0);
      ctx.rotate(p0.angle);
      ctx.strokeStyle = "green";
      ctx.strokeRect(0, 0, viewRect.x1 - viewRect.x0, viewRect.y1 - viewRect.y0);
      ctx.resetTransform();
      await this.debugImage();
    }
    ctx.putImageData(oldImageData, 0, 0);

    this.cropCanvas(viewRect, viewRect.angle);
    await this.debugImage();
    const p1 = await this.locateViewAreaBottom(scheduler, ctx);
    const oldImageData2 = ctx.getImageData(0, 0, this.canvas.width, this.canvas.height);

    {
      ctx.strokeStyle = "green";
      ctx.strokeRect(0, 0, p1.x, p1.y);
      await this.debugImage();
    }
    this.canvas.width = p1.x;
    this.canvas.height = p1.y;
    ctx.putImageData(oldImageData2, 0, 0);
    await this.debugImage();
  }

  private async locateViewAreaTop(scheduler: Scheduler, ctx: CanvasRenderingContext2D) {
    const imageData = ctx.getImageData(0, 0, this.canvas.width, this.canvas.height);
    const worker = new Worker(new URL("./locator.worker.ts", import.meta.url), { type: 'module' });
    const procImage = await runWorker<OCRPreprocessMessageInput, OCRPreprocessMessageOutput>(worker, {
      width: imageData.width,
      height: imageData.height,
      data: imageData.data,
    }, [imageData.data.buffer]);
    ctx.putImageData(new ImageData(procImage, imageData.width, imageData.height), 0, 0);
    const imageUrl = this.canvas.toDataURL();
    await this.debugImage(imageUrl);

    const result = await scheduler.addJob("recognize", imageUrl);
    let republikWord: Word | undefined, indonesiaWord: Word | undefined;
    for (const line of result.data.lines) {
      const { republik, indonesia } = PassportOCR.findWordsInLine(line, ["republik", "indonesia"]);
      if (republik && indonesia) {
        republikWord = republik;
        indonesiaWord = indonesia;
        break;
      }
    }
    if (!republikWord || !indonesiaWord) {
      throw new Error("Cannot find top-left end of passport");
    }
    const width = (indonesiaWord.bbox.x1 - republikWord.bbox.x0);
    const height = indonesiaWord.bbox.y1 - indonesiaWord.bbox.y0;

    const angle = Math.atan2(
      // Get average of y0 and y1 differences
      ((indonesiaWord.bbox.y0 - republikWord.bbox.y0) + (indonesiaWord.bbox.y1 - republikWord.bbox.y1)) / (this.canvas.height * 2),
      (indonesiaWord.bbox.x1 - republikWord.bbox.x0) / this.canvas.width);
    const y0 = -indonesiaWord.bbox.x1 * Math.sin(angle) + (indonesiaWord.bbox.y1 + height) * Math.cos(angle);

    return {
      x: republikWord.bbox.x0 - (republikWord.bbox.x1 - republikWord.bbox.x0) * 0.1,
      y: y0,
      // Predicted width and height. This doesn't have to be accurate, but just enough so that locateViewAreaBottom can find the last two lines in the passport.
      width: width * 1.35,
      y1: width * 1.4,
      angle,
    }
  }


  private async locateViewAreaBottom(scheduler: Scheduler, ctx: CanvasRenderingContext2D) {
    const imageData = ctx.getImageData(0, 0, this.canvas.width, this.canvas.height);
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
    // Find the line with the most digits (that's probably the bottom-most line in the passport)
    for (let i = 0; i < result.data.lines.length; i++) {
      const line = result.data.lines[i];
      let numberCount = 0;
      const ZERO = '0'.charCodeAt(0);
      for (const chr of line.text) {
        const ascii = chr.charCodeAt(0);
        if (ZERO <= ascii && ascii <= ZERO + 9) {
          numberCount++;
        }
      }
      if (numberCount > 8) {
        endOfPassport = i;
      }
    }

    if (endOfPassport === -1) {
      throw new Error("Cannot find bottom-right end of passport");
    }
    const relevantLines = result.data.lines.slice(Math.max(endOfPassport - 7, 0), endOfPassport - 1);
    const rightEdges = relevantLines.slice(Math.max(0, relevantLines.length - 3), relevantLines.length).map(x => x.bbox.x1);
    rightEdges.sort((a, b) => a - b);
    const rightEdgesMedian = median(rightEdges);

    return {
      x: rightEdgesMedian,
      y: relevantLines[relevantLines.length - 1].bbox.y1,
    }
  }

  private async readTarget(scheduler: Scheduler, target: OCRTarget, imgUrl: string) {
    const width = (target.bbox.x1 - target.bbox.x0) * this.canvas.width;
    const height = (target.bbox.y1 - target.bbox.y0) * this.canvas.height;
    const x = target.bbox.x0 * this.canvas.width;
    const y = target.bbox.y0 * this.canvas.height;

    const result = await scheduler.addJob("recognize", imgUrl, {
      rectangle: {
        left: x,
        top: y,
        width,
        height,
      }
    });
    return result.data.lines[0] ?? null;
  }
  private async markBoxes(boxes: Bbox[]) {
    const ctx = this.canvasContext;
    ctx.strokeStyle = "green"
    for (const box of boxes) {
      ctx.strokeRect(box.x0, box.y0, box.x1 - box.x0, box.y1 - box.y0);
    }
  }
  private processLine(key: keyof typeof PassportOCR.targets, line: Line) {
    let text: string | null = line.text.trim();
    const originalTarget = PassportOCR.targets[key];
    if (typeof originalTarget.corrector === 'function') {
      text = originalTarget.corrector(text);
    } else if (!!originalTarget.corrector) {
      const history = this.options.history[key];
      if (history && history.length > 0) {
        const candidate = closest(text, history);
        if (distance(text, candidate) < Math.ceil(text.length * 2 / 3)) {
          text = candidate;
        }
      }
    }
    return text;
  }

  updateHistory(payload: PassportOCRPayload): PassportOCRHistory {
    for (const rawKey of Object.keys(PassportOCR.targets)) {
      const key = rawKey as keyof typeof PassportOCR.targets;
      const targetCorrector = PassportOCR.targets[key].corrector;
      if (typeof targetCorrector === 'function' || !targetCorrector) {
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
          history.unshift();
        }
      }
    }
    return this.options.history;
  }

  async run(): Promise<PassportOCRPayload> {
    const scheduler = await this.getScheduler();

    const result: Record<string, Line> = {};
    await Promise.all(Object.keys(PassportOCR.targets).map(async (k) => {
      const key = k as keyof typeof PassportOCR.targets;
      const value = PassportOCR.targets[key];
      result[key] = await this.readTarget(scheduler, value, this.canvas.toDataURL());
    }))
    if (
      (!result.sex && result.sex2) ||
      (result.sex && result.sex2 && result.sex.confidence < result.sex2.confidence)) {
      result.sex = result.sex2;
    }
    delete result.sex2;

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
      payload[key] = result[key] ? this.processLine(key as keyof typeof PassportOCR.targets, result[key]) : null;
    }

    return payload as PassportOCRPayload;
  }

  async terminate() {
    await this._scheduler?.terminate();
  }
}