import { Bbox, Line, Rectangle, Scheduler, Word, createScheduler, createWorker, detect } from "tesseract.js";
import OCR, { OCRHistory, OCROptions, OCRResult, OCRTarget } from "../ocr";
import KTPCardOCRTargets, { KTPCardOCRTarget } from "./targets";
import { copyImageData, correctByHistory, runWorker } from "../ocr/utils";
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
      left: 0,
      width: this.canvas.width,
      top: 0,
      height: bottomY,
    });
    await this.debugImage();


    return () => {
      canvasCopy.crop({
        left: rect.left - rect.wordWidth * 0.4,
        top: rect.top - rect.wordHeight * 2,
        width: rect.width,
        height: rect.wordHeight * 2,
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
    return this.processLine(this.targets.NIK, line);
  }

  private async detectBloodType() {
    const scheduler = await this.multiplexor.getScheduler(SchedulerKeys.default);
    const rectangle = this.canvas.getCanvasRectFromRelativeRect({
      x0: 0.9,
      x1: 1,
      y0: 0.2,
      y1: 0.32,
    });
    const result = await scheduler.addJob("recognize", this.canvas.toDataURL(), { rectangle });
    await this.canvas.markBoxes([rectangle]);
    await this.debugImage();
    const line = result.data.lines[0];
    if (!line) {
      return null;
    }
    return this.processLine(this.targets.NIK, line);
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
      left: x0,
      top: y0,
      width: provinsiWidth * 2.5,
      height: provinsiWidth * 2.7,
      angle,
      wordHeight: provinsiWord.bbox.y1 - provinsiWord.bbox.y0,
      wordWidth: provinsiWidth,
    }
  }

  async run(): Promise<OCRResult<typeof KTPCardOCRTargets>> {
    const detectNIK = await this.locateViewArea();
    const scheduler = await this.multiplexor.getScheduler(SchedulerKeys.default);

    const payload: KTPCardOCRResult = {} as any;
    const [result, nik, bloodType] = await Promise.all([
      scheduler.addJob("recognize", this.canvas.toDataURL()),
      detectNIK(),
      this.detectBloodType(),
    ]);
    payload.NIK = nik;
    payload.bloodType = bloodType;

    const placeOfBirth = result.data.lines[1].text.trim().split(' ');
    const dateOfBirth = placeOfBirth.pop();
    payload.placeOfBirth = this.processLine(this.targets.placeOfBirth, placeOfBirth.join(' '));
    payload.dateOfBirth = dateOfBirth ? this.processLine(this.targets.dateOfBirth, dateOfBirth) : null;


    const indicesToTargetMap: Record<number, KTPCardOCRTarget> = {};
    for (const key of Object.keys(this.targets)) {
      const target = this.targets[key as keyof typeof this.targets];
      if (target.index != null) {
        indicesToTargetMap[target.index] = target;
      }
    }

    for (let i = 0; i < result.data.lines.length; i++) {
      const line = result.data.lines[i];
      const target = indicesToTargetMap[i];
      if (!target) continue;
      console.log(target.key);
      payload[target.key as keyof KTPCardOCRResult] = this.processLine(target, line);
    }

    console.log(result.data.lines.map(x => x.text));
    return payload;
  }
}