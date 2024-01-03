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
  // number = "number",
  // alphabet = "alphabet",
  default = "default",
}

export default class KTPCardOCR extends OCR<typeof KTPCardOCRTargets, SchedulerKeys> {
  targets = KTPCardOCRTargets;
  constructor(options: Partial<OCROptions<typeof KTPCardOCRTargets>>) {
    super({
      ...options,
      multiplexorConfig: {
        // [SchedulerKeys.number]: {
        //   count: 1,
        //   initOptions: {
        //     load_freq_dawg: '0',
        //     load_number_dawg: '0',
        //     load_system_dawg: '0',
        //   },
        //   params: {
        //     tessedit_char_whitelist: '0123456789'
        //   }
        // },
        // [SchedulerKeys.alphabet]: {
        //   count: 1,
        //   initOptions: {
        //     load_freq_dawg: '0',
        //     load_number_dawg: '0',
        //     load_system_dawg: '0',
        //   },
        //   params: {
        //     tessedit_char_whitelist: Array.from({ length: 26 }, (_, i) => String.fromCharCode(i + 65)).concat(
        //       ' ',
        //       Array.from({ length: 26 }, (_, i) => String.fromCharCode(i + 97)),
        //     ).join(''),
        //   }
        // },
        [SchedulerKeys.default]: {
          count: 2,
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
    await this.debugImage();

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


    return async () => {
      canvasCopy.crop({
        left: rect.left - rect.wordWidth * 0.4,
        top: rect.wordY0,
        width: rect.width + rect.wordWidth,
        height: rect.top - rect.wordY0,
      }, rect.angle);
      return this.recognizeKTPTopInformation(canvasCopy);
    }
  }

  /** Gets information only available at the top of the KTP card such as province, regency/city, and NIK */
  private async recognizeKTPTopInformation(canvas: OCRCanvas) {
    const scheduler = await this.multiplexor.getScheduler(SchedulerKeys.default);
    const imgUrl = canvas.toDataURL();
    // Splitting the image up into three sections makes the OCR output gibberish. I have no idea why.
    // Just scan the entirety of the image.
    const result = await scheduler.addJob("recognize", imgUrl);
    await this.debugImage(imgUrl);

    const provinceLine = result.data.lines[0];
    const regencyCityLine = result.data.lines[1];
    const nikLine = result.data.lines[2];

    const regencyParsed = regencyCityLine ? this.processLine(this.targets.regency, regencyCityLine) : null;
    console.log(result.data);

    return {
      province: provinceLine ? this.processLine(this.targets.province, provinceLine) : null,
      regency: regencyParsed,
      // If we managed to parse regency, then city is null; otherwise try to parse city.
      // Parsing is successful if the text starts with KABUPATEN or CITY
      city: regencyCityLine && !regencyParsed ? this.processLine(this.targets.city, regencyCityLine) : null,
      NIK: nikLine ? this.processLine(this.targets.NIK, nikLine) : null,
    };
  }

  private async recognizeBloodType() {
    const scheduler = await this.multiplexor.getScheduler(SchedulerKeys.default);
    const rectangle = this.canvas.getCanvasRectFromRelativeRect({
      x0: 0.8,
      x1: 1,
      y0: 0.15,
      y1: 0.3,
    });
    const result = await scheduler.addJob("recognize", this.canvas.toDataURL(), { rectangle });
    await this.canvas.markBoxes([rectangle]);
    await this.debugImage();
    const line = result.data.lines[0];
    if (!line) {
      return null;
    }
    return this.processLine(this.targets.bloodType, line);
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
    const y0 = provinsiWord.bbox.y1 + provinsiWidth * 0.7;


    const angle = !surroundingWord ? 0 : Math.atan2(
      ((surroundingWord.bbox.y0 - provinsiWord.bbox.y0) + (surroundingWord.bbox.y1 - provinsiWord.bbox.y1)) / 2 / this.canvas.height,
      (surroundingWord.bbox.x1 - provinsiWord.bbox.x0) / this.canvas.width);
    return {
      left: x0,
      top: y0,
      width: provinsiWidth * 2.7,
      height: provinsiWidth * 2.7,
      angle,
      wordWidth: provinsiWidth,
      wordY0: provinsiWord.bbox.y0,
    }
  }

  async run(): Promise<OCRResult<typeof KTPCardOCRTargets>> {
    const recognizeKTPTopInfo = await this.locateViewArea();
    const scheduler = await this.multiplexor.getScheduler(SchedulerKeys.default);

    const payload: KTPCardOCRResult = {} as any;
    const [result, ktpTop, bloodType] = await Promise.all([
      scheduler.addJob("recognize", this.canvas.toDataURL()),
      recognizeKTPTopInfo(),
      this.recognizeBloodType(),
    ]);
    for (const key of Object.keys(ktpTop)) {
      payload[key as keyof KTPCardOCRResult] = ktpTop[key as keyof typeof ktpTop];
    }
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
      payload[target.key as keyof KTPCardOCRResult] = this.processLine(target, line);
    }

    return payload;
  }
}