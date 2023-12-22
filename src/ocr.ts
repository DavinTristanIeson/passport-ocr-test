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
  await new Promise((resolve) => setTimeout(resolve, 10000));
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
        y1: 0.180,
      },
    },
    countryCode: {
      bbox: {
        x0: 0.240,
        y0: 0.080,
        x1: 0.560,
        y1: 0.180
      },
    },
    passportNumber: {
      bbox: {
        x0: 0.670,
        y0: 0.080,
        x1: 0.960,
        y1: 0.200,
      },
    },
    fullName: {
      bbox: {
        x0: 0.010,
        y0: 0.250,
        x1: 0.780,
        y1: 0.350,
      },
    },
    sex: {
      bbox: {
        x0: 0.800,
        y0: 0.250,
        x1: 0.960,
        y1: 0.350,
      },
    },
    nationality: {
      bbox: {
        x0: 0.010,
        y0: 0.400,
        x1: 0.780,
        y1: 0.500,
      },
    },
    dateOfBirth: {
      bbox: {
        x0: 0.010,
        y0: 0.565,
        x1: 0.350,
        y1: 0.665,
      },
    },
    sex2: {
      bbox: {
        x0: 0.400,
        y0: 0.565,
        x1: 0.540,
        y1: 0.665,
      },
    },
    placeOfBirth: {
      bbox: {
        x0: 0.600,
        y0: 0.565,
        x1: 0.960,
        y1: 0.665
      },
    },
    dateOfIssue: {
      bbox: {
        x0: 0.010,
        y0: 0.710,
        x1: 0.350,
        y1: 0.810,
      },
    },
    dateofExpiry: {
      bbox: {
        x0: 0.640,
        y0: 0.710,
        x1: 0.960,
        y1: 0.810,
      },
    },
    regNumber: {
      bbox: {
        x0: 0.010,
        y0: 0.890,
        x1: 0.500,
        y1: 1,
      },
    },
    issuingOffice: {
      bbox: {
        x0: 0.500,
        y0: 0.890,
        x1: 0.960,
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
    const workers = await Promise.all(Array.from({ length: WORKER_COUNT }, () => createWorker("ind")));
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

    const viewBoundary = await this.locateViewArea();
    ctx.drawImage(image, 0, 0);

    const viewWidth = viewBoundary.x1 - viewBoundary.x0;
    const viewHeight = viewBoundary.y1 - viewBoundary.y0
    const viewSection = ctx.getImageData(viewBoundary.x0, viewBoundary.y0, viewWidth, viewHeight);
    this.canvas.width = viewWidth;
    this.canvas.height = viewHeight;
    ctx.putImageData(viewSection, 0, 0);
    await this.debugImage();

    const worker = new Worker(new URL("./preprocess.worker.ts", import.meta.url), { type: 'module' });
    const procImage = await runWorker<OCRPreprocessMessageInput, OCRPreprocessMessageOutput>(worker, {
      width: this.canvas.width,
      height: this.canvas.height,
      data: viewSection.data,
    }, [viewSection.data.buffer]);

    ctx.putImageData(new ImageData(procImage, this.canvas.width, this.canvas.height), 0, 0);
    await this.debugImage();
  }

  private async locateViewArea(): Promise<Bbox> {
    const scheduler = await this.getScheduler();
    const ctx = this.canvasContext;

    const imageData = ctx.getImageData(0, 0, this.canvas.width, this.canvas.height);
    const worker = new Worker(new URL("./locator.worker.ts", import.meta.url), { type: 'module' });
    const procImage = await runWorker<OCRPreprocessMessageInput, OCRPreprocessMessageOutput>(worker, {
      width: imageData.width,
      height: imageData.height,
      data: imageData.data,
    }, [imageData.data.buffer]);
    const oldImageData = ctx.getImageData(0, 0, this.canvas.width, this.canvas.height);
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
      throw new Error("Cannot find passport");
    }
    const width = (indonesiaWord.bbox.x1 - republikWord.bbox.x0);
    const y0 = Math.max(indonesiaWord.bbox.y1, republikWord.bbox.y1);
    const height = (y0 - Math.max(republikWord.bbox.y0, indonesiaWord.bbox.y0));

    const viewRect = {
      x0: republikWord.bbox.x0 - (republikWord.bbox.x1 - republikWord.bbox.x0) * 0.1,
      y0: y0 + height,
      x1: indonesiaWord.bbox.x0 + (width * 1.4),
      y1: y0 + height + (width * 1.25),
    }
    ctx.strokeStyle = "green";
    ctx.strokeRect(viewRect.x0, viewRect.y0, viewRect.x1 - viewRect.x0, viewRect.y1 - viewRect.y0);
    await this.debugImage();
    ctx.putImageData(oldImageData, 0, 0);

    return viewRect;
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