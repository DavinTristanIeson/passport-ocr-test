import { Bbox, Line, Word } from "tesseract.js";
import OCR, { OCRHistory, OCROptions, OCRResult } from "../ocr";
import KTPCardOCRTargets, { KTPCardOCRTarget, KTP_DATE_REGEX } from "./targets";
import { copyImageData, runWorker, trimWhitespace } from "../ocr/utils";
import { KTPCardOCRPreprocessMessageInput, KTPCardOCRPreprocessMessageOutput } from "./preprocess.worker";
import { distance } from "fastest-levenshtein";
import OCRCanvas from "../ocr/canvas";
import { correctStartsWith } from "../ocr/correctors";

export type KTPCardOCRResult = OCRResult<typeof KTPCardOCRTargets>;
export type KTPCardOCRHistory = OCRHistory<typeof KTPCardOCRTargets>;
export type KTPCardOCROptions = OCROptions<typeof KTPCardOCRTargets> & {
  recommendedWidth: number;
  recommendedKTPSectionWidth: number;
};

enum SchedulerKeys {
  number = "number",
  // alphabet = "alphabet",
  default = "default",
}

export default class KTPCardOCR extends OCR<typeof KTPCardOCRTargets, SchedulerKeys> {
  options: KTPCardOCROptions;
  targets = KTPCardOCRTargets;
  constructor(options: Partial<KTPCardOCROptions>) {
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
            load_freq_dawg: '1',
            load_number_dawg: '0',
            load_system_dawg: '0',
          },
          params: {
            tessedit_char_blacklist: `,."'“:`
          }
        }
      }
    });
    this.options = {
      history: options?.history ?? {},
      historyLimit: options?.historyLimit ?? 10,
      onProcessImage: options?.onProcessImage,
      recommendedWidth: options?.recommendedWidth ?? 1080,
      recommendedKTPSectionWidth: options?.recommendedKTPSectionWidth ?? 640,
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
    // const bottomY = await this.locateViewAreaBottom();
    // this.canvas.crop({
    //   left: 0,
    //   width: this.canvas.width,
    //   top: 0,
    //   height: bottomY,
    // });
    // await this.debugImage();


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
    const numberScheduler = await this.multiplexor.getScheduler(SchedulerKeys.number);
    const imgUrl = canvas.toDataURL();
    canvas.toWidth(this.options.recommendedKTPSectionWidth);
    // Splitting the image up into three sections makes the OCR output gibberish. I have no idea why.
    // Just scan the entirety of the image.
    const [result, nikResult] = await Promise.all([
      // Segmenting this with rectangle makes the output worse in quality
      scheduler.addJob("recognize", imgUrl),
      numberScheduler.addJob("recognize", imgUrl)
    ]);
    await this.debugImage(imgUrl);

    let findProvince = correctStartsWith(["provinsi"]);
    let provinceIndex = result.data.lines.findIndex((value) => findProvince(value.text) !== null);
    if (provinceIndex === -1) {
      provinceIndex = Math.max(0, result.data.lines.length - 3);
    }
    const relevantLines = result.data.lines.slice(provinceIndex);
    const provinceLine = relevantLines[0];
    const regencyCityLine = relevantLines[1];
    const nikLine = nikResult.data.lines[nikResult.data.lines.length - 1];
    console.log(result.data, nikResult.data);

    const regencyParsed = regencyCityLine ? this.processLine(this.targets.regency, regencyCityLine) : null;

    return {
      province: provinceLine ? this.processLine(this.targets.province, provinceLine) : null,
      regency: regencyParsed,
      // If we managed to parse regency, then city is null; otherwise try to parse city.
      // Parsing is successful if the text starts with KABUPATEN or CITY
      city: regencyCityLine && !regencyParsed ? this.processLine(this.targets.city, regencyCityLine) : null,
      NIK: nikLine ? this.processLine(this.targets.NIK, nikLine) : null,
    };
  }

  private getNIKBoundingBox(line: Line): {
    text: string;
    bbox: Bbox;
  } | null {
    const startIdx = line.words.findIndex(word => distance(word.text.trim(), "NIK") <= 1);
    if (startIdx === -1 || startIdx === line.words.length - 1) {
      return null;
    }

    let text = line.words[startIdx + 1].text.trim();
    let bbox = { ...line.words[startIdx + 1].bbox };

    let maxSymbolDistance = 0;
    const exampleSymbols = line.words[startIdx].symbols;
    let prevSymbolX1 = exampleSymbols[0].bbox.x1;
    for (let i = 1; i < exampleSymbols.length; i++) {
      const symbol = exampleSymbols[i];
      maxSymbolDistance = Math.max(symbol.bbox.x0 - prevSymbolX1, maxSymbolDistance);
      prevSymbolX1 = symbol.bbox.x1;
    }

    const maxWordDistance = maxSymbolDistance * 6;
    let prevWordX1 = line.words[startIdx + 1].bbox.x1;
    for (let i = startIdx + 1; i < line.words.length; i++) {
      const word = line.words[i];
      const wordDistance = word.bbox.x0 - prevWordX1;
      if (maxWordDistance < wordDistance) {
        break;
      }
      bbox.y0 = Math.min(bbox.y0, word.bbox.y0);
      bbox.y1 = Math.max(bbox.y1, word.bbox.y1);
      bbox.x1 = word.bbox.x1;
      prevWordX1 = word.bbox.x1;
      text += word.text;
    }
    return {
      text, bbox
    }
  }

  private async locateViewAreaTop() {
    const scheduler = await this.multiplexor.getScheduler(SchedulerKeys.default);

    const result = await scheduler.addJob("recognize", this.canvas.toDataURL());

    let provinsiWord: Bbox | undefined, surroundingWord: Bbox | undefined, nikWord: Bbox | undefined;
    for (const line of result.data.lines) {
      nikWord = this.getNIKBoundingBox(line)?.bbox;

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
    const nikHeight = nikWord.y1 - nikWord.y0;
    const x0 = nikWord.x0;
    const y0 = nikWord.y1 + nikHeight * 0.1;


    const angle = !surroundingWord || !provinsiWord ? 0 : Math.atan2(
      ((surroundingWord.y0 - provinsiWord.y0) + (surroundingWord.y1 - provinsiWord.y1)) / 2 / this.canvas.height,
      (surroundingWord.x1 - provinsiWord.x0) / this.canvas.width);
    return {
      left: x0,
      top: y0,
      width: nikWidth * 1.1,
      height: nikWidth * 0.85,
      angle,
      wordWidth: nikWidth,
      wordHeight: nikWord.y1 - nikWord.y0,
    }
  }

  async run(): Promise<OCRResult<typeof KTPCardOCRTargets>> {
    this.canvas.toWidth(this.options.recommendedWidth);
    const recognizeKTPTopInfo = await this.locateViewArea();
    this.canvas.toWidth(this.options.recommendedKTPSectionWidth);
    const scheduler = await this.multiplexor.getScheduler(SchedulerKeys.default);

    const payload: KTPCardOCRResult = {} as any;
    for (let key of Object.keys(this.targets)) {
      payload[key as keyof KTPCardOCRResult] = null;
    }

    const [result, ktpTop] = await Promise.all([
      scheduler.addJob("recognize", this.canvas.toDataURL()),
      recognizeKTPTopInfo(),
    ]);
    for (const key of Object.keys(ktpTop)) {
      payload[key as keyof KTPCardOCRResult] = ktpTop[key as keyof typeof ktpTop];
    }

    let placeOfBirth = trimWhitespace(result.data.lines[1].text);
    let dateOfBirthMatch = placeOfBirth.match(KTP_DATE_REGEX);
    if (dateOfBirthMatch) {
      placeOfBirth = placeOfBirth.slice(0, dateOfBirthMatch.index);
    } else {
      dateOfBirthMatch = trimWhitespace(result.data.lines[2].text).match(KTP_DATE_REGEX);
      if (dateOfBirthMatch) {
        result.data.lines.splice(2, 1);
      }
    }
    payload.dateOfBirth = dateOfBirthMatch ? this.processLine(this.targets.dateOfBirth, dateOfBirthMatch[0]) : null;
    payload.placeOfBirth = dateOfBirthMatch ? this.processLine(this.targets.placeOfBirth, placeOfBirth) : null;

    const sexRow = trimWhitespace(result.data.lines[2].text);
    const wordsInSexRow = sexRow.split(' ');
    const bloodType = wordsInSexRow[wordsInSexRow.length - 1];
    payload.sex = wordsInSexRow[0] ? this.processLine(this.targets.sex, wordsInSexRow[0]) : null;
    payload.bloodType = bloodType ? this.processLine(this.targets.bloodType, bloodType) : null;

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

    console.log(result.data);

    return payload;
  }
}