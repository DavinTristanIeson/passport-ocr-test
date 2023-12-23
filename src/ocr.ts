import { type ImageLike, createScheduler, type Bbox, createWorker, Scheduler, RecognizeResult, Word, Line } from "tesseract.js";
import { distance } from 'fastest-levenshtein';
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
}

type PassportOCRPayload = {
  [key in keyof typeof PassportOCR.targets]: string | null;
};
interface PassportOCROptions {
  onProcessImage?: (objectUrl: string) => void | Promise<void>;
}
export default class PassportOCR {
  static targets = {
    type: {
      bbox: {
        x0: 0.010,
        y0: 0.080,
        x1: 0.230,
        y1: 0.200,
      },
    },
    countryCode: {
      bbox: {
        x0: 0.240,
        y0: 0.080,
        x1: 0.560,
        y1: 0.200
      },
    },
    passportNumber: {
      bbox: {
        x0: 0.600,
        y0: 0.080,
        x1: 1,
        y1: 0.200,
      },
    },
    fullName: {
      bbox: {
        x0: 0.010,
        y0: 0.230,
        x1: 0.780,
        y1: 0.350,
      },
    },
    sex: {
      bbox: {
        x0: 0.800,
        y0: 0.230,
        x1: 1,
        y1: 0.350,
      },
    },
    nationality: {
      bbox: {
        x0: 0.010,
        y0: 0.380,
        x1: 0.780,
        y1: 0.500,
      },
    },
    dateOfBirth: {
      bbox: {
        x0: 0.010,
        y0: 0.540,
        x1: 0.350,
        y1: 0.660,
      },
    },
    sex2: {
      bbox: {
        x0: 0.360,
        y0: 0.540,
        x1: 0.540,
        y1: 0.660,
      },
    },
    placeOfBirth: {
      bbox: {
        x0: 0.560,
        y0: 0.540,
        x1: 1,
        y1: 0.660
      },
    },
    dateOfIssue: {
      bbox: {
        x0: 0.010,
        y0: 0.700,
        x1: 0.350,
        y1: 0.820,
      },
    },
    dateofExpiry: {
      bbox: {
        x0: 0.640,
        y0: 0.700,
        x1: 1,
        y1: 0.820,
      },
    },
    regNumber: {
      bbox: {
        x0: 0.010,
        y0: 0.880,
        x1: 0.500,
        y1: 1,
      },
    },
    issuingOffice: {
      bbox: {
        x0: 0.500,
        y0: 0.880,
        x1: 1,
        y1: 1,
      },
    }
  } satisfies Record<string, OCRTarget>;
  canvas: HTMLCanvasElement;
  _scheduler: Scheduler | undefined;
  options: PassportOCROptions;
  constructor(options?: Partial<PassportOCROptions>) {
    this.canvas = document.createElement("canvas");
    this.getScheduler();
    this.options = {
      onProcessImage: options?.onProcessImage,
    };
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
    const workers = await Promise.all(Array.from({ length: WORKER_COUNT }, () => createWorker("ind", undefined, undefined, {
      // https://github.com/tesseract-ocr/tessdoc/blob/main/ImproveQuality.md
      // Most words are not dictionary words; numbers should be treated as digits
      load_system_dawg: '0',
      load_freq_dawg: '0',
      load_number_dawg: '0',
    })));
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
    const relevantLines = result.data.lines.slice(Math.max(endOfPassport - 2 - 6, 0), endOfPassport - 1);
    const rightEdges = relevantLines.slice(Math.max(0, relevantLines.length - 3), relevantLines.length).map(x => x.bbox.x1);
    rightEdges.sort((a, b) => a - b);
    const rightEdgesMedian = median(rightEdges);
    console.log(relevantLines, rightEdges, rightEdgesMedian);

    return {
      x: rightEdgesMedian,
      y: relevantLines[relevantLines.length - 1].bbox.y1,
    }
  }

  private async readTarget(scheduler: Scheduler, target: OCRTarget, ctx: CanvasRenderingContext2D) {
    const width = (target.bbox.x1 - target.bbox.x0) * this.canvas.width;
    const height = (target.bbox.y1 - target.bbox.y0) * this.canvas.height;
    const x = target.bbox.x0 * this.canvas.width;
    const y = target.bbox.y0 * this.canvas.height;
    const imageSection = ctx.getImageData(x, y, width, height);
    const imageSectionUrl = getObjectUrlOfImageData(imageSection, width, height);

    const result = await scheduler.addJob("recognize", imageSectionUrl);
    return result.data.lines[0] ?? null;
  }
  private async markBoxes(boxes: Bbox[]) {
    const ctx = this.canvasContext;
    ctx.strokeStyle = "green"
    for (const box of boxes) {
      ctx.strokeRect(box.x0, box.y0, box.x1 - box.x0, box.y1 - box.y0);
    }
  }
  private processLine(line: Line): string {
    return line.text.trim();
  }

  async run(): Promise<PassportOCRPayload> {
    const ctx = this.canvasContext;
    const scheduler = await this.getScheduler();
    const result = Object.fromEntries(await Promise.all(Object.entries(PassportOCR.targets).map(async (entry) => {
      return [entry[0], await this.readTarget(scheduler, entry[1], ctx)] as const;
    })));
    if (
      (!result.sex && result.sex2) ||
      (result.sex && result.sex2 && result.sex.confidence < result.sex2.confidence)) {
      result.sex = result.sex2;
    }
    delete result.sex2;
    this.markBoxes(Object.values(PassportOCR.targets).filter(x => x != null).map(({ bbox }) => ({
      x0: bbox.x0 * this.canvas.width,
      y0: bbox.y0 * this.canvas.height,
      x1: bbox.x1 * this.canvas.width,
      y1: bbox.y1 * this.canvas.height,
    })));
    await this.debugImage();
    return Object.fromEntries(Object.entries(result).map(entry => [entry[0], entry[1] ? this.processLine(entry[1]) : null])) as PassportOCRPayload;
  }

  async terminate() {
    await this._scheduler?.terminate();
  }
}