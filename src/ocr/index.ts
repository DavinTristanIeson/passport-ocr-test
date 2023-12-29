import type { Scheduler, Bbox, Line } from "tesseract.js";
import OCRCanvas from "./canvas";
import { closest, distance } from "fastest-levenshtein";

export type OCRTarget = {
  key: string;
  bbox: Bbox;
  corrector?: ((value: string, history: string[] | undefined) => string | null) | boolean;
}
export type OCRTargetReadResult = { text: string, confidence: number };

export type OCRResult<TTarget extends Record<string, any>> = {
  [key in keyof TTarget]: string | null;
};
export type OCRHistory<TTarget extends Record<string, any>> = {
  [key in keyof TTarget]?: string[];
}

export interface OCROptions<TTarget extends object> {
  /** Callback for debugging */
  onProcessImage?: (objectUrl: string) => void | Promise<void>;
  /** An object containing previous manually corrected values */
  history: OCRHistory<TTarget>;
  /** How many history entries should be stored at a time */
  historyLimit: number;
}

export default abstract class OCR<TTarget extends Record<string, any>> {
  abstract targets: TTarget;
  options: OCROptions<TTarget>;
  canvas: OCRCanvas;
  constructor(options?: Partial<OCROptions<TTarget>>) {
    this.canvas = new OCRCanvas();
    this.options = {
      history: options?.history ?? {},
      historyLimit: options?.historyLimit ?? 10,
      onProcessImage: options?.onProcessImage,
    }
    this.getScheduler();
  }

  /** Mount the file on the canvas. This must be performed before ``run`` */
  mountFile(file: File): Promise<void> {
    return this.canvas.mountFile(file);
  }
  abstract run(): Promise<OCRResult<TTarget>>;
  /** Cleans up all existing workers. Make sure to call this function when the page is closed */
  abstract terminate(): Promise<void>;

  // Get the Scheduler used for the OCR
  protected abstract getScheduler(): Promise<Scheduler>;

  /** Processes a line outputted by the OCR.
   *  If the original target has a corrector function, the corrector function will be invoked.
   *  If it is a truthy value, the line will be compared with similar entries in its history to find the closest match.
   *  Otherwise, the original line is returned.
   */
  protected processLine(target: OCRTarget, line: Line | string): string | null {
    let text: string | null = typeof line === 'string' ? line : line.text.trim();
    const history = this.options.history[target.key];
    if (typeof target.corrector === 'function') {
      text = target.corrector(text, history);
    } else if (!!target.corrector) {
      if (history && history.length > 0) {
        const candidate = closest(text, history);
        if (distance(text, candidate) < Math.ceil(text.length * 2 / 3)) {
          text = candidate;
        }
      }
    }
    return text;
  }

  /** Updates the history with the CORRECTED version of the payload. Call this function after an employee has verified passport contents.
   * 
   *  This step is optional. However, previous corrected words can be used to correct the output of the OCR.
   */
  updateHistory(payload: OCRResult<TTarget>): OCRHistory<TTarget> {
    for (const rawKey of Object.keys(this.targets)) {
      const key = rawKey as keyof TTarget;
      const targetCorrector = this.targets[key].corrector;
      if (!targetCorrector) {
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
          history.shift();
        }
      }
    }
    return this.options.history;
  }

  protected async debugImage(imageUrl?: string, wait?: number) {
    // if (this.options.onProcessImage) {
    //   await this.options.onProcessImage(imageUrl || this.canvas.toDataURL());
    //   if (wait) {
    //     await new Promise((resolve) => setTimeout(resolve, wait));
    //   }
    // }
  }
}