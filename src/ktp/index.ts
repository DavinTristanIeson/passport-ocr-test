import { Bbox, Rectangle, Scheduler, Word, createScheduler, createWorker, detect } from "tesseract.js";
import OCR, { OCRHistory, OCROptions, OCRResult } from "../ocr";
import KTPCardOCRTargets from "./targets";
import { copyImageData, runWorker } from "../ocr/utils";
import { KTPCardOCRPreprocessMessageInput, KTPCardOCRPreprocessMessageOutput } from "./preprocess.worker";
import { distance } from "fastest-levenshtein";
import OCRCanvas from "../ocr/canvas";

export type KTPCardOCRResult = OCRResult<typeof KTPCardOCRTargets>;
export type KTPCardOCRHistory = OCRHistory<typeof KTPCardOCRTargets>;

enum SchedulerKeys {
  number = "number",
  default = "default",
}

export default class KTPCardOCR extends OCR<typeof KTPCardOCRTargets, SchedulerKeys> {
  targets = KTPCardOCRTargets;
  constructor(options: Partial<OCROptions<typeof KTPCardOCRTargets>>) {
    super({
      ...options,
      multiplexorConfig: {
        [SchedulerKeys.number]: {
          count: 1,
          initOptions: {
            load_freq_dawg: '0',
            load_number_dawg: '0',
            load_system_dawg: '0',
          },
          params: {
            tessedit_char_whitelist: '0123456789'
          }
        },
        [SchedulerKeys.default]: {
          count: 4,
          initOptions: {
            load_freq_dawg: '0',
            load_number_dawg: '0',
            load_system_dawg: '0',
          },
          params: {
            tessedit_char_blacklist: `,."'“:`
          }
        }
      }
    });
  }

  private async locateViewArea() {
    const worker = new Worker(new URL("./preprocess.worker.ts", import.meta.url));
    const ctx = this.canvas.context;
    const imageData = ctx.getImageData(0, 0, this.canvas.width, this.canvas.height)
    const procImage = await runWorker<KTPCardOCRPreprocessMessageInput, KTPCardOCRPreprocessMessageOutput>(worker, {
      data: imageData.data,
      width: imageData.width,
      height: imageData.height,
    }, [imageData.data.buffer]);
    ctx.putImageData(new ImageData(procImage, imageData.width, imageData.height), 0, 0);

    const canvasCopy = new OCRCanvas(copyImageData(this.canvas.context.getImageData(0, 0, this.canvas.width, this.canvas.height)));

    const rect = await this.locateViewAreaTop();
    this.canvas.crop(rect);
    await this.debugImage();
    const bottomY = await this.locateViewAreaBottom();
    this.canvas.crop({
      x0: 0,
      x1: this.canvas.width,
      y0: 0,
      y1: bottomY,
    });
    await this.debugImage();


    return () => {
      canvasCopy.crop({
        x0: rect.x0 - rect.wordWidth * 0.4,
        y0: rect.y0 - rect.wordHeight * 2,
        x1: rect.x1,
        y1: rect.y0,
      }, rect.angle);
      return this.detectNIK(canvasCopy);
    }
  }

  private async detectNIK(canvas: OCRCanvas) {
    const scheduler = await this.multiplexor.getScheduler(SchedulerKeys.number);
    const imgUrl = canvas.toDataURL();
    await this.debugImage(imgUrl);
    const result = await scheduler.addJob("recognize", imgUrl);
    const line = result.data.lines[0];
    if (!line) {
      return null;
    }
    return this.processLine({} as any, line);
  }

  private async locateViewAreaBottom(): Promise<number> {
    const scheduler = await this.multiplexor.getScheduler(SchedulerKeys.default);
    const result = await scheduler.addJob("recognize", this.canvas.toDataURL(), {
      rectangle: this.canvas.getCanvasRectFromRelativeRect({
        x0: 0,
        x1: 1,
        y0: 0.7,
        y1: 1,
      }),
    });
    const lastLine = result.data.lines[result.data.lines.length - 1];
    if (!lastLine) {
      throw new Error("Cannot find bottom-left corner of the passport");
    }
    return lastLine.bbox.y1;
  }

  private async locateViewAreaTop() {
    const scheduler = await this.multiplexor.getScheduler(SchedulerKeys.default);

    const result = await scheduler.addJob("recognize", this.canvas.toDataURL());
    let provinsiWord: Word | undefined, surroundingWord: Word | undefined;
    find: for (const line of result.data.lines) {
      let index = 0;
      for (const word of line.words) {
        const candidate = word.text.trim().toUpperCase();
        if (distance(candidate, "PROVINSI") <= 3) {
          provinsiWord = word;
          surroundingWord = line.words[index + 1];
          break find;
        }
        index++;
      }
    }
    if (!provinsiWord) {
      throw new Error("Cannot find top-left corner of KTP");
    }
    const provinsiWidth = provinsiWord.bbox.x1 - provinsiWord.bbox.x0;
    const x0 = provinsiWord.bbox.x0 - provinsiWidth * 0.3;
    const y0 = provinsiWord.bbox.y1 + provinsiWidth * 0.55;


    const angle = !surroundingWord ? 0 : Math.atan2(
      ((surroundingWord.bbox.y0 - provinsiWord.bbox.y0) + (surroundingWord.bbox.y1 - provinsiWord.bbox.y1)) / 2 / this.canvas.height,
      (surroundingWord.bbox.x1 - provinsiWord.bbox.x0) / this.canvas.width);
    return {
      x0,
      y0,
      x1: x0 + provinsiWidth * 2.5,
      y1: y0 + provinsiWidth * 2.7,
      angle,
      wordHeight: provinsiWord.bbox.y1 - provinsiWord.bbox.y0,
      wordWidth: provinsiWidth,
    }
  }

  async run(): Promise<OCRResult<typeof KTPCardOCRTargets>> {
    const detectNIK = await this.locateViewArea();
    const scheduler = await this.multiplexor.getScheduler(SchedulerKeys.default);

    const result = await scheduler.addJob("recognize", this.canvas.toDataURL());
    const payload = result.data.lines.map(line => this.processLine({} as any, line))
    const nik = await detectNIK();
    console.log(payload, nik);
    return payload as any;
  }
}