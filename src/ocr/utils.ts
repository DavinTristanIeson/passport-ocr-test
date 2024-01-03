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
    if (distance(text, candidate) <= Math.ceil(candidate.length / 3)) {
      text = candidate;
    }
  }
  return text;
}

export function correctAlphabet(options?: {
  withHistory?: boolean;
  maxLength?: number;
  whitelist?: string;
}) {
  const withHistory = options?.withHistory ?? true;
  const whitelist = options?.whitelist ?? '';
  return (value: string, history?: string[]) => {
    let text = Array.from(value.toUpperCase()).filter(chr => {
      const ascii = chr.charCodeAt(0);
      const isUppercaseAlpha = 65 <= ascii && ascii <= 65 + 26;
      return isUppercaseAlpha || whitelist.includes(chr)
    }).join('').trim();
    if (options?.maxLength !== undefined) {
      text = text.substring(0, options.maxLength);
    }
    if (text.length === 0) {
      return null;
    }
    return withHistory ? correctByHistory(text, history) : text;
  }
}

export function combineUnique<T>(a: T[], b: T[]) {
  return Array.from(new Set(a.concat(b)));
}

export function correctEnums(enums: string[], options?: {
  exact?: boolean;
  history?: boolean;
}) {
  return (value: string, history?: string[]) => {
    const candidates = (options?.history ?? true) && history ? combineUnique(enums, history) : enums;
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
      temp = corrector(temp, history);
      if (temp === null) break;
    }
    return temp;
  }
}
export function anyCorrectors(correctors: ((text: string, history: string[]) => string | null)[]) {
  return function (text: string, history: string[]) {
    for (let corrector of correctors) {
      const corrected = corrector(text, history);
      if (corrected !== null) {
        return corrected;
      }
    }
    return null;
  }
}

export function pad0(num: number): string {
  return (num < 10 ? `0${num}` : num.toString());
}