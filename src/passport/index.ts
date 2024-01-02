import { createScheduler, type Bbox, createWorker, type Scheduler, type Word, type Line, type Rectangle } from "tesseract.js";
import { distance } from 'fastest-levenshtein';
import { PassportOCRPreprocessMessageInput, PassportOCRPreprocessMessageOutput } from "./preprocess.worker";
import OCR, { OCROptions, OCRResult, OCRTarget, OCRTargetReadResult } from "../ocr";
import PassportOCRTargets, { PassportOCRTarget } from "./targets";
import { copyImageData, runWorker } from "../ocr/utils";
import OCRCanvas from "../ocr/canvas";
import TaskPool, { TaskResultStatus } from "../ocr/task-pool";

function median(arr: number[]) {
  if (arr.length % 2 === 0) {
    return (arr[arr.length / 2 - 1] + arr[arr.length / 2]) / 2;
  } else {
    return arr[Math.floor(arr.length / 2)];
  }
}


interface PassportOCROptions extends OCROptions<typeof PassportOCRTargets> {
  /** The recommended width of the passport view area. Larger sizes mean that the font would be clearer, but the OCR would take a longer time to finish processing. */
  recommendedPassportViewWidth: number;
  /** The recommended width of the entire image */
  recommendedFullWidth: number;
  /** The recommended passport number image width at the bottom of the passport */
  recommendedPassportNumberImageWidth: number;
}

enum SchedulerKeys {
  number = "number",
  default = "default",
}

/** Helper class to perform OCR for passports.
 * 
 *  The recommended flow is: ``mountFile`` (to locate the relevant passport section) -> ``run`` (perform OCR) -> ...repeat... -> ``terminate`` (after you're done)
 *  
 *  Note that ``mountFile`` and ``run`` mutates the state of the canvas. It is recommended that if an error occurs, you should repeat from the ``mountFile`` stage. */
export default class PassportOCR extends OCR<typeof PassportOCRTargets, SchedulerKeys> {
  targets = PassportOCRTargets;
  options: PassportOCROptions;
  constructor(options?: Partial<PassportOCROptions>) {
    super({
      ...options,
      multiplexorConfig: {
        [SchedulerKeys.number]: {
          count: 2,
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
    this.options = {
      history: options?.history ?? {},
      historyLimit: options?.historyLimit ?? 10,
      onProcessImage: options?.onProcessImage,
      recommendedPassportViewWidth: options?.recommendedPassportViewWidth ?? 960,
      recommendedFullWidth: options?.recommendedFullWidth ?? 1440,
      recommendedPassportNumberImageWidth: options?.recommendedPassportNumberImageWidth ?? 320,
    };
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

  /** Locate the section of the image which contain the relevant information. This function will mutate the canvas. */
  private async locateViewArea() {
    const scheduler = await this.multiplexor.getScheduler(SchedulerKeys.default);
    const ctx = this.canvas.context;
    const oldImageData = ctx.getImageData(0, 0, this.canvas.width, this.canvas.height);
    const p0 = await this.locateViewAreaTop(scheduler, ctx);
    const viewRect = {
      x0: p0.x,
      y0: p0.y,
      x1: p0.x + p0.width,
      y1: p0.y + p0.height,
      angle: p0.angle,
    }

    ctx.putImageData(oldImageData, 0, 0);

    // Backup original image
    const tempCanvas = copyImageData(ctx.getImageData(0, 0, this.canvas.width, this.canvas.height));
    this.canvas.crop(viewRect, viewRect.angle);
    await this.debugImage();
    const p1 = await this.locateViewAreaBottom(scheduler, ctx);
    const oldImageData2 = ctx.getImageData(0, 0, this.canvas.width, this.canvas.height);

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
      return this.getPassportNumberAlternative(scheduler, new OCRCanvas(tempCanvas), {
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
    const procImage = await runWorker<PassportOCRPreprocessMessageInput, PassportOCRPreprocessMessageOutput>(worker, {
      width: imageData.width,
      height: imageData.height,
      data: imageData.data,
      // Second parameter is of Transferable data types. Since ``imageData.data.buffer`` is an ArrayBuffer, it can be transferred over to the web worker rather than copied.
      // That also means that imageData.data can no longer be used in this scope.
    }, [imageData.data.buffer]);
    ctx.putImageData(new ImageData(procImage, imageData.width, imageData.height), 0, 0);
    const imageUrl = this.canvas.toDataURL();
    await this.debugImage(imageUrl);


    const sections = this.canvas.distributeOverlappingCells(3);
    await this.canvas.markBoxes(sections);
    await this.debugImage();
    type ViewAreaTopLocateResult = {
      republikWord: Word | undefined;
      indonesiaWord: Word | undefined;
      pasporWord: Word | undefined;
    }
    const pool = new TaskPool<ViewAreaTopLocateResult>(async (i) => {
      const rectangle = sections[i];
      const result = await scheduler.addJob("recognize", imageUrl, { rectangle });
      // Find any of these words (note that republik and indonesia must both appear in the same line)
      let republikWord: Word | undefined, indonesiaWord: Word | undefined, pasporWord: Word | undefined;
      for (const line of result.data.lines) {
        const { republik, indonesia, paspor } = PassportOCR.findWordsInLine(line, ["republik", "indonesia", "paspor"]);
        if (republik && indonesia) {
          republikWord = republik;
          indonesiaWord = indonesia;
          return {
            type: TaskResultStatus.ShortCircuit,
            value: {
              republikWord,
              indonesiaWord,
              pasporWord,
            }
          }
        }
        if (paspor && !pasporWord) {
          pasporWord = paspor;
        }
      }
      if (pasporWord) {
        return {
          type: TaskResultStatus.Complete,
          value: {
            republikWord,
            indonesiaWord,
            pasporWord,
          }
        }
      } else {
        return {
          type: TaskResultStatus.Ignore,
        }
      }
    }, {
      count: sections.length,
      limit: scheduler.getNumWorkers(),
    });

    const result = await pool.latest();
    if (!result) {
      throw new Error("Cannot find top-left end of passport");
    }
    const { republikWord, indonesiaWord, pasporWord } = result;

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
    const procImage = await runWorker<PassportOCRPreprocessMessageInput, PassportOCRPreprocessMessageOutput>(preprocessWorker, {
      width: imageData.width,
      height: imageData.height,
      data: imageData.data,
    }, [imageData.data.buffer]);
    ctx.putImageData(new ImageData(procImage, imageData.width, imageData.height), 0, 0);
    await this.debugImage();

    const result = await scheduler.addJob("recognize", this.canvas.toDataURL(), {
      rectangle: this.canvas.getCanvasRectFromRelativeRect({
        x0: 0.5,
        x1: 1,
        y0: 0,
        y1: 1,
      })
    });

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
  private async getPassportNumberAlternative(scheduler: Scheduler, canvas: OCRCanvas, box: Bbox, pivot: {
    x: number,
    y: number,
    angle: number,
  }): Promise<OCRTargetReadResult | null> {
    const ctx = canvas.context;
    canvas
      .rotate(pivot)
      .crop(box, 0)
      .toWidth(this.options.recommendedPassportNumberImageWidth);
    await this.debugImage(canvas.toDataURL());

    const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
    const preprocessWorker = new Worker(new URL("./preprocess.worker.ts", import.meta.url), { type: 'module' });
    const procImage = await runWorker<PassportOCRPreprocessMessageInput, PassportOCRPreprocessMessageOutput>(preprocessWorker, {
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

    const processedLine = this.processLine(this.targets["passportNumber"], line);
    return processedLine ? {
      text: processedLine,
      confidence: line.confidence,
    } : null;
  }

  /** Separates a date target rectangle into three sections for day month and year */
  private getDateTargetRectangles(target: PassportOCRTarget): Rectangle[] {
    const fullRect = this.canvas.getCanvasRectFromRelativeRect(target.bbox);

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

  private async readDateTarget(scheduler: Scheduler, target: PassportOCRTarget, imgUrl: string): Promise<OCRTargetReadResult | null> {
    const sections = this.getDateTargetRectangles(target);
    const numberScheduler = await this.multiplexor.getScheduler(SchedulerKeys.number);
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

    const processedLine = !!day && !!month && !!year ? this.processLine(target, `${day.text} ${month.text} ${year.text}`) : null;
    return processedLine ? {
      text: processedLine,
      confidence: (day!.confidence + month!.confidence + year!.confidence) / 3
    } : null;
  }

  /** Perform OCR on a target. ``imgUrl`` can be retrieved from ``this.canvas.toDataURL()`` */
  private async readTarget(scheduler: Scheduler, target: PassportOCRTarget, imgUrl: string): Promise<OCRTargetReadResult | null> {
    const rectangle = this.canvas.getCanvasRectFromRelativeRect(target.bbox);

    // With rectangle, we don't need to make explicit copies of the image. The same image can be passed to the scheduler.
    const [result, altResult] = await Promise.all([
      scheduler.addJob("recognize", imgUrl, {
        rectangle
      }),
      // Also perform a redundant check by splitting the date into three for potentially better recognition
      target.isDate ? this.readDateTarget(scheduler, target, imgUrl) : null
    ]);
    // Greedily grab the first line and hope for the best.
    const line = result.data.lines[0];
    const processedLine = line ? this.processLine(target, line) : null;

    // Compare the confidence of the alternative result with this result.
    if (altResult && altResult.confidence > line.confidence) {
      return altResult;
    }
    return processedLine ? { text: processedLine, confidence: line.confidence } : null;
  }

  /** Performs OCR */
  async run(): Promise<OCRResult<typeof PassportOCRTargets>> {
    this.canvas.toWidth(this.options.recommendedFullWidth);
    const getPassportNumberAlt = await this.locateViewArea();
    const scheduler = await this.multiplexor.getScheduler(SchedulerKeys.default);
    this.canvas.toWidth(this.options.recommendedPassportViewWidth)

    const result: Record<string, OCRTargetReadResult | null> = {};
    const imgUrl = this.canvas.toDataURL();

    const promises: Promise<unknown>[] = Object.keys(this.targets).map(async (k) => {
      const key = k as keyof typeof this.targets;
      const value = this.targets[key];
      result[key] = await this.readTarget(scheduler, value, imgUrl);
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
    for (const key of Object.keys(this.targets)) {
      const target = this.targets[key as keyof typeof this.targets];
      if (target.isDate) {
        boxes.push(...this.getDateTargetRectangles(target));
      }
      boxes.push(this.canvas.getCanvasRectFromRelativeRect(target.bbox));
    }
    this.canvas.markBoxes(boxes);
    await this.debugImage();

    // Extract only the text as returned data
    const payload: Record<string, string | null> = {};
    for (const key of Object.keys(result)) {
      const value = result[key];
      payload[key] = value ? value.text : null;
    }

    return payload as OCRResult<typeof PassportOCRTargets>;
  }
}