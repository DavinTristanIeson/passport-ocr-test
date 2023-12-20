import { type ImageLike, createScheduler, type Bbox, createWorker, Scheduler, RecognizeResult } from "tesseract.js";
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

type OCRTarget = {
  bbox: Bbox;
}

type PassportOCRPayload = {
  [key in keyof typeof PassportOCR.targets]: string | null;
};
interface PassportOCROptions {
  labelTolerance: number;
}
export default class PassportOCR {
  static targets = {
    type: {
      bbox: {
        x0: 0.320,
        y0: 0.175,
        x1: 0.450,
        y1: 0.240,
      },
    },
    countryCode: {
      bbox: {
        x0: 0.470,
        y0: 0.170,
        x1: 0.700,
        y1: 0.250
      },
    },
    passportNumber: {
      bbox: {
        x0: 0.760,
        y0: 0.160,
        x1: 0.960,
        y1: 0.260,
      },
    },
    fullName: {
      bbox: {
        x0: 0.320,
        y0: 0.260,
        x1: 0.630,
        y1: 0.350,
      },
    },
    sex: {
      bbox: {
        x0: 0.850,
        y0: 0.260,
        x1: 0.960,
        y1: 0.348,
      },
    },
    nationality: {
      bbox: {
        x0: 0.320,
        y0: 0.362,
        x1: 0.630,
        y1: 0.456,
      },
    },
    dateOfBirth: {
      bbox: {
        x0: 0.320,
        y0: 0.466,
        x1: 0.538,
        y1: 0.553,
      },
    },
    placeOfBirth: {
      bbox: {
        x0: 0.630,
        y0: 0.462,
        x1: 0.960,
        y1: 0.557
      },
    },
    dateOfIssue: {
      bbox: {
        x0: 0.320,
        y0: 0.570,
        x1: 0.630,
        y1: 0.647,
      },
    },
    dateofExpiry: {
      bbox: {
        x0: 0.630,
        y0: 0.560,
        x1: 0.960,
        y1: 0.654,
      },
    },
    regNumber: {
      bbox: {
        x0: 0.320,
        y0: 0.665,
        x1: 0.630,
        y1: 0.780,
      },
    },
    issuingOffice: {
      bbox: {
        x0: 0.630,
        y0: 0.665,
        x1: 0.960,
        y1: 0.780,
      },
    }
  } satisfies Record<string, OCRTarget>;
  canvas: HTMLCanvasElement;
  _scheduler: Scheduler | undefined;
  options: PassportOCROptions;
  constructor(canvas: HTMLCanvasElement, options?: Partial<PassportOCROptions>) {
    this.canvas = canvas;
    this.getScheduler();
    this.options = {
      labelTolerance: Math.min(1, Math.max(0, options?.labelTolerance ?? 0.3)),
    };
  }
  private async getScheduler(): Promise<Scheduler> {
    if (this._scheduler !== undefined) {
      return this._scheduler;
    }
    const WORKER_COUNT = 4;
    this._scheduler = await createScheduler();
    for (let i = 0; i < WORKER_COUNT; i++) {
      this._scheduler.addWorker(await createWorker("ind"));
    }
    return this._scheduler;
  }
  private get canvasContext(): CanvasRenderingContext2D {
    return this.canvas.getContext("2d", {
      willReadFrequently: true,
    })!;
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
    const imageData = ctx.getImageData(0, 0, this.canvas.width, this.canvas.height)!;

    const worker = new Worker(new URL("./preprocess.worker.ts", import.meta.url), { type: 'module' });
    const procImage = await new Promise<OCRPreprocessMessageOutput>((resolve, reject) => {
      worker.onmessage = (e) => resolve(e.data);
      worker.onerror = reject;
      worker.postMessage({
        width: this.canvas.width,
        height: this.canvas.height,
        data: imageData.data,
      } satisfies OCRPreprocessMessageInput, [imageData.data.buffer]);
    });

    ctx.putImageData(new ImageData(procImage, imageData.width, imageData.height), 0, 0);

    return this.canvas.toDataURL();
  }

  private async readTarget(scheduler: Scheduler, target: OCRTarget, ctx: CanvasRenderingContext2D) {
    const width = (target.bbox.x1 - target.bbox.x0) * this.canvas.width;
    const height = (target.bbox.y1 - target.bbox.y0) * this.canvas.height;
    const x = target.bbox.x0 * this.canvas.width;
    const y = target.bbox.y0 * this.canvas.height;
    const imageSection = ctx.getImageData(x, y, width, height);
    const imageSectionUrl = getObjectUrlOfImageData(imageSection, width, height);

    const result = await scheduler.addJob("recognize", imageSectionUrl);
    console.log(result.data);
    return result.data.lines[0]?.text.trim() ?? null;
  }
  async run(): Promise<PassportOCRPayload> {
    const ctx = this.canvasContext;
    const scheduler = await this.getScheduler();
    const result = Object.fromEntries(await Promise.all(Object.entries(PassportOCR.targets).map(async (entry) => {
      return [entry[0], await this.readTarget(scheduler, entry[1], ctx)] as const;
    })));

    return result as PassportOCRPayload;
  }

  async terminate() {
    await this._scheduler?.terminate();
  }
}