import { getDocument } from "pdfjs-dist";
import type { Bbox, Rectangle } from "tesseract.js";
// If you're bundling pdf.js along with the rest of the code, the worker needs to be loaded so that the bundler is aware of it.
import 'pdfjs-dist/build/pdf.worker.min.mjs';
import { copyImageData } from "./utils";

interface CanvasPivot {
  x: number;
  y: number;
  angle: number;
}

export default class OCRCanvas {
  /** This can be attached to a DOM tree for debugging purposes. All painting operations to process images for OCR will be performed on this. */
  canvas: HTMLCanvasElement;
  constructor(canvas?: HTMLCanvasElement) {
    this.canvas = canvas ?? document.createElement('canvas');
  }

  get width(): number {
    return this.canvas.width;
  }
  get height(): number {
    return this.canvas.height;
  }
  set width(value: number) {
    this.canvas.width = value;
  }
  set height(value: number) {
    this.canvas.height = value;
  }

  get context(): CanvasRenderingContext2D {
    return this.canvas.getContext("2d", {
      willReadFrequently: true,
    })!;
  }

  clear() {
    this.context.clearRect(0, 0, this.canvas.width, this.canvas.height);
    return this;
  }

  toDataURL() {
    return this.canvas.toDataURL();
  }

  rotate(pivot: CanvasPivot) {
    const canvas = this.canvas;
    const ctx = this.context;

    const tempCanvas = document.createElement("canvas");
    tempCanvas.width = canvas.width;
    tempCanvas.height = canvas.height;
    const tempCtx = tempCanvas.getContext('2d', {
      willReadFrequently: true,
    })!;
    tempCtx.translate(-pivot.x, -pivot.y);
    tempCtx.rotate(-pivot.angle);
    tempCtx.drawImage(canvas, pivot.x, pivot.y);
    tempCtx.translate(pivot.x, pivot.y);
    tempCtx.resetTransform();

    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(tempCanvas, 0, 0);
    return this;
  }

  /** Mutates the canvas with the cropped image. */
  crop(box: Bbox, angle: number = 0) {
    const width = box.x1 - box.x0;
    const height = box.y1 - box.y0;
    const canvas = this.canvas;
    const ctx = this.context;
    const tempCanvas = document.createElement("canvas");
    tempCanvas.width = canvas.width;
    tempCanvas.height = canvas.height;
    const tempCtx = tempCanvas.getContext('2d', {
      willReadFrequently: true,
    })!;
    tempCtx.translate(-box.x0, -box.y0);
    tempCtx.rotate(-angle);
    tempCtx.drawImage(canvas, 0, 0);

    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(tempCanvas, 0, 0);
    const cropped = ctx.getImageData(0, 0, width, height);
    ctx.resetTransform();
    canvas.width = width;
    canvas.height = height;
    ctx.putImageData(cropped, 0, 0);
    return this;
  }

  private async mountImageFile(file: File) {
    // Load the image
    // https://stackoverflow.com/questions/32272904/converting-blob-file-data-to-imagedata-in-javascript
    const fileUrl = URL.createObjectURL(file);
    const image = new Image();
    image.src = fileUrl;
    await new Promise<void>((resolve, reject) => {
      image.onload = () => {
        this.canvas.width = image.width;
        this.canvas.height = image.height;
        URL.revokeObjectURL(fileUrl);
        resolve();
      }
      image.onerror = reject;
    });
    const ctx = this.context;
    ctx.drawImage(image, 0, 0);
  }
  private async mountPdfFile(file: File) {
    const pdf = await getDocument(await file.arrayBuffer()).promise;
    const firstPage = await pdf.getPage(1);
    const viewport = firstPage.getViewport({
      scale: 1,
    });
    this.canvas.width = viewport.width;
    this.canvas.height = viewport.height;
    await firstPage.render({
      canvasContext: this.context,
      viewport,
    }).promise;
  }
  async mountFile(file: File): Promise<void> {
    if (file.type === "application/pdf") {
      return this.mountPdfFile(file);
    } else {
      return this.mountImageFile(file);
    }
  }

  /** For debug purposes. Mark the target boxes on the canvas */
  async markBoxes(boxes: Rectangle[]) {
    const ctx = this.context;
    ctx.strokeStyle = "green"
    for (const box of boxes) {
      ctx.strokeRect(box.left, box.top, box.width, box.height);
    }
    return this;
  }

  /** Tesseract seems to perform better when the text is bigger. This would increase the amount of time for OCR,
   *  but at the very least, small images can now be recognized properly. */
  toWidth(width: number, options?: {
    // If the width exceeds recommendedWidth, should the image be downscaled or not
    shouldDownscale?: boolean;
  }) {
    const shouldDownscale = options?.shouldDownscale ?? true;
    if (this.canvas.width > width && !shouldDownscale) {
      return this;
    }

    const scaleFactor = width / this.canvas.width;
    const ctx = this.context;
    const imageCopy = copyImageData(ctx.getImageData(0, 0, this.canvas.width, this.canvas.height));
    this.canvas.width = width;
    this.canvas.height = this.canvas.height * scaleFactor;
    ctx.drawImage(imageCopy, 0, 0, this.canvas.width, this.canvas.height);
    return this;
  }

  /** Given a relative rectangle, find the rectangle position on the canvas */
  getCanvasRectFromRelativeRect(bbox: Bbox): Rectangle {
    const width = (bbox.x1 - bbox.x0) * this.canvas.width;
    const height = (bbox.y1 - bbox.y0) * this.canvas.height;
    const left = bbox.x0 * this.canvas.width;
    const top = bbox.y0 * this.canvas.height;
    return { left, top, width, height };
  }
}