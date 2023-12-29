export function runWorker<TInput, TOutput>(worker: Worker, input: TInput, transfer?: Transferable[]): Promise<TOutput> {
  return new Promise<TOutput>((resolve, reject) => {
    worker.onmessage = (e) => resolve(e.data as TOutput);
    worker.onerror = reject;
    worker.postMessage(input, transfer || []);
  });
}

export function copyImageData(data: ImageData): HTMLCanvasElement {
  const tempCanvas = document.createElement("canvas");
  tempCanvas.width = data.width;
  tempCanvas.height = data.height;
  const tempCtx = tempCanvas.getContext('2d')!;
  tempCtx.putImageData(data, 0, 0);
  return tempCanvas;
}