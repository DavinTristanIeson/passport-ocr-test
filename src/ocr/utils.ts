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

export function combineUnique<T>(a: T[], b: T[]) {
  return Array.from(new Set(a.concat(b)));
}

export function pad0(num: number): string {
  return (num < 10 ? `0${num}` : num.toString());
}

export function trimWhitespace(value: string) {
  // Remove whitespace
  return value.trim().split(/\s+/).join(' ');
}