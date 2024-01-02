import { closest, distance } from "fastest-levenshtein";

export function runWorker<TInput, TOutput>(worker: Worker, input: TInput, transfer?: Transferable[]): Promise<TOutput> {
  return new Promise<TOutput>((resolve, reject) => {
    worker.onmessage = (e) => resolve(e.data as TOutput);
    worker.onerror = reject;
    worker.postMessage(input, transfer || []);
  });
}

export function copyImageData(data: ImageData | HTMLCanvasElement): HTMLCanvasElement {
  const tempCanvas = document.createElement("canvas");
  tempCanvas.width = data.width;
  tempCanvas.height = data.height;
  const tempCtx = tempCanvas.getContext('2d')!;
  if (data instanceof HTMLCanvasElement) {
    tempCtx.drawImage(data, 0, 0);
  } else {
    tempCtx.putImageData(data, 0, 0);
  }
  return tempCanvas;
}

export function correctByHistory(text: string, history: string[] | undefined) {
  if (!text) return null;
  if (history && history.length > 0) {
    const candidate = closest(text, history);
    if (distance(text, candidate) < Math.ceil(text.length * 2 / 3)) {
      text = candidate;
    }
  }
  return text;
}

export function correctAlphabet(options?: {
  withHistory?: boolean;
  withSpaces?: boolean;
  maxLength?: number;
}) {
  const withHistory = options?.withHistory ?? true;
  const withSpaces = options?.withSpaces ?? false;
  return (value: string, history?: string[]) => {
    let text = Array.from(value.toUpperCase()).filter(chr => {
      const ascii = chr.charCodeAt(0);
      const isUppercaseAlpha = 65 <= ascii && ascii <= 65 + 26;
      const isSpace = chr === ' ';
      return isUppercaseAlpha || (withSpaces && isSpace);
    }).join('').trim();
    if (options?.maxLength !== undefined) {
      text = text.substring(0, options.maxLength);
    }
    return withHistory ? correctByHistory(text, history) : text;
  }
}

export function correctEnums(enums: string[], options?: {
  exact?: boolean;
  history?: boolean;
}) {
  return (value: string, history?: string[]) => {
    const candidates = (options?.history ?? true) && history ? enums.concat(history) : enums;
    const corrected = correctByHistory(value, candidates);
    if (options?.exact && !candidates.find(x => x === corrected)) {
      return null;
    }
    return corrected;
  }
}

export function mergeCorrectors(correctors: ((text: string, history: string[]) => string | null)[]) {
  return function (text: string, history: string[]) {
    let temp: string | null = text;
    for (let corrector of correctors) {
      temp = corrector(text, history);
      if (temp === null) break;
    }
    return temp;
  }
}

export function pad0(num: number): string {
  return (num < 10 ? `0${num}` : num.toString());
}