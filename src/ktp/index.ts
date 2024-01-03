import { Bbox, Line, Word } from "tesseract.js";
import OCR, { OCRHistory, OCROptions, OCRResult } from "../ocr";
import KTPCardOCRTargets, { KTPCardOCRTarget, KTP_DATE_REGEX } from "./targets";
import { copyImageData, runWorker, trimWhitespace } from "../ocr/utils";
import { KTPCardOCRPreprocessMessageInput, KTPCardOCRPreprocessMessageOutput } from "./preprocess.worker";
import { distance } from "fastest-levenshtein";
import OCRCanvas from "../ocr/canvas";

export type KTPCardOCRResult = OCRResult<typeof KTPCardOCRTargets>;
export type KTPCardOCRHistory = OCRHistory<typeof KTPCardOCRTargets>;
export type KTPCardOCROptions = OCROptions<typeof KTPCardOCRTargets> & {
  recommendedWidth: number;
};

enum SchedulerKeys {
  // number = "number",
  // alphabet = "alphabet",
  default = "default",
}

function countDigits(str: string) {
  let countNumbers = 0;
  for (let chr of str) {
    const ascii = chr.charCodeAt(0);
    const isDigit = 48 <= ascii && ascii <= 48 + 9;
    if (isDigit) {
      countNumbers++;
    }
  }
  return countNumbers;
}

export default class KTPCardOCR extends OCR<typeof KTPCardOCRTargets, SchedulerKeys> {
  options: KTPCardOCROptions;
  targets = KTPCardOCRTargets;
  constructor(options: Partial<KTPCardOCROptions>) {
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
          count: 3,
          initOptions: {
            load_freq_dawg: '0',
            load_number_dawg: '0',
            load_system_dawg: '0',
          },
          params: {
            tessedit_char_blacklist: `,"'“:`
          }
        }
      }
    });
    this.options = {
      history: options?.history ?? {},
      historyLimit: options?.historyLimit ?? 10,
      onProcessImage: options?.onProcessImage,
      recommendedWidth: options?.recommendedWidth ?? 1440,
    }
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
    this.canvas.crop(rect, rect.angle);
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
      const height = rect.wordHeight * 6;
      canvasCopy.crop({
        left: rect.left - rect.wordWidth * 0.5,
        top: rect.top - height,
        width: rect.width + rect.wordWidth,
        height: height + (rect.wordHeight * 0.2),
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

    const relevantLines = result.data.lines.slice(result.data.lines.length - 3);
    const provinceLine = relevantLines[0];
    const regencyCityLine = relevantLines[1];
    const nikLine = relevantLines[2];

    const regencyParsed = regencyCityLine ? this.processLine(this.targets.regency, regencyCityLine) : null;
    const nikString = this.gatherPartsOfNIK(nikLine)?.text;

    console.log(result.data);

    return {
      province: provinceLine ? this.processLine(this.targets.province, provinceLine) : null,
      regency: regencyParsed,
      // If we managed to parse regency, then city is null; otherwise try to parse city.
      // Parsing is successful if the text starts with KABUPATEN or CITY
      city: regencyCityLine && !regencyParsed ? this.processLine(this.targets.city, regencyCityLine) : null,
      NIK: nikString ? this.processLine(this.targets.NIK, nikString) : null,
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
    // await this.canvas.markBoxes([rectangle]);
    // await this.debugImage();
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
        y0: 0.6,
        y1: 1,
      }),
    });
    const lastLine = result.data.lines[result.data.lines.length - 1];
    if (!lastLine) {
      throw new Error("Cannot find bottom-left corner of the passport");
    }
    return lastLine.bbox.y1;
  }

  private isPartOfNIK(word: Word) {
    const isMostlyDigits = countDigits(word.text) >= word.text.length * 2 / 3;
    const hasSignificance = word.text.length > 3;
    return isMostlyDigits && hasSignificance;
  }
  private gatherPartsOfNIK(line: Line): {
    text: string;
    bbox: Bbox;
  } | null {
    const startIdx = line.words.findIndex(this.isPartOfNIK);
    if (startIdx === -1) {
      return null;
    }
    let text = line.words[startIdx].text;
    let bbox = { ...line.words[startIdx].bbox };
    for (let i = startIdx + 1; i < line.words.length; i++) {
      const word = line.words[i];
      if (!this.isPartOfNIK(word)) break;
      bbox.y0 = Math.min(bbox.y0, word.bbox.y0);
      bbox.y1 = Math.max(bbox.y1, word.bbox.y1);
      bbox.x1 = Math.max(bbox.x1, word.bbox.x1);
      text += word.text;
    }
    return {
      text, bbox
    }
  }

  private async locateViewAreaTop() {
    const scheduler = await this.multiplexor.getScheduler(SchedulerKeys.default);

    const result = await scheduler.addJob("recognize", this.canvas.toDataURL());
    console.log(result.data.lines);

    let provinsiWord: Bbox | undefined, surroundingWord: Bbox | undefined, nikWord: Bbox | undefined;
    for (const line of result.data.lines) {
      if (countDigits(line.text) >= 10) {
        nikWord = this.gatherPartsOfNIK(line)?.bbox;
      }

      for (let i = 0; i < line.words.length; i++) {
        const word = line.words[i];
        const candidate = word.text.trim().toUpperCase();
        if (distance(candidate, "PROVINSI") <= 3) {
          provinsiWord = word.bbox;
          surroundingWord = line.words[i + 1]?.bbox;
        }
      }

      if (nikWord && provinsiWord) {
        break;
      }
    }
    if (!nikWord) {
      throw new Error("Cannot find top-left corner of KTP");
    }
    this.canvas.markBoxes([
      {
        left: nikWord.x0,
        top: nikWord.y0,
        width: nikWord.x1 - nikWord.x0,
        height: nikWord.y1 - nikWord.y0,
      }
    ]);
    await this.debugImage();
    const nikWidth = nikWord.x1 - nikWord.x0;
    const x0 = nikWord.x0;
    const y0 = nikWord.y1


    const angle = !surroundingWord || !provinsiWord ? 0 : Math.atan2(
      ((surroundingWord.y0 - provinsiWord.y0) + (surroundingWord.y1 - provinsiWord.y1)) / 2 / this.canvas.height,
      (surroundingWord.x1 - provinsiWord.x0) / this.canvas.width);
    return {
      left: x0,
      top: y0,
      width: nikWidth * 1.1,
      height: nikWidth * 1.3,
      angle,
      wordWidth: nikWidth,
      wordHeight: nikWord.y1 - nikWord.y0,
    }
  }

  async run(): Promise<OCRResult<typeof KTPCardOCRTargets>> {
    this.canvas.toWidth(this.options.recommendedWidth);
    const recognizeKTPTopInfo = await this.locateViewArea();
    const scheduler = await this.multiplexor.getScheduler(SchedulerKeys.default);

    const payload: KTPCardOCRResult = {} as any;
    for (let key of Object.keys(this.targets)) {
      payload[key as keyof KTPCardOCRResult] = null;
    }

    const [result, ktpTop, bloodType] = await Promise.all([
      scheduler.addJob("recognize", this.canvas.toDataURL()),
      recognizeKTPTopInfo(),
      this.recognizeBloodType(),
    ]);
    console.log(result.data);
    for (const key of Object.keys(ktpTop)) {
      payload[key as keyof KTPCardOCRResult] = ktpTop[key as keyof typeof ktpTop];
    }
    payload.bloodType = bloodType;

    let placeOfBirth = trimWhitespace(result.data.lines[1].text);
    const dateOfBirthMatch = placeOfBirth.match(KTP_DATE_REGEX);
    if (dateOfBirthMatch) {
      payload.dateOfBirth = dateOfBirthMatch ? this.processLine(this.targets.dateOfBirth, dateOfBirthMatch[0]) : null;
      placeOfBirth = placeOfBirth.slice(0, dateOfBirthMatch.index);
    }
    payload.placeOfBirth = dateOfBirthMatch ? this.processLine(this.targets.placeOfBirth, placeOfBirth) : null;


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
      payload[target.key as keyof KTPCardOCRResult] = line ? this.processLine(target, line) : null;
    }

    return payload;
  }
}