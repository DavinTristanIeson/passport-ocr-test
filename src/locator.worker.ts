import type { OCRPreprocessMessageInput, OCRPreprocessMessageOutput } from "./preprocess.worker";

function grayscale(data: Uint8ClampedArray) {
  for (let i = 0; i < data.length; i += 4) {
    const absRedDiff = Math.min(Math.max(0, data[i + 1] - data[i]), Math.max(0, data[i + 2] - data[i]));
    const singleOutBlueGreen = 255 - (Math.pow(absRedDiff / 5, 4) / 255) * 255;

    const brightness = Math.max(0, Math.min(255, singleOutBlueGreen));
    for (let offset = 0; offset < 3; offset++) {
      data[i + offset] = brightness;
    }
  }
  return data;
}

function binarize(data: Uint8ClampedArray): Uint8ClampedArray {
  const UPPER_THRESHOLD = 64;
  const LOWER_THRESHOLD = 32;
  for (let i = 0; i < data.length; i++) {
    if (data[i] > UPPER_THRESHOLD) {
      data[i] = 255;
    } else if (data[i] < LOWER_THRESHOLD) {
      data[i] = 0;
    }
  }
  return data;
}


self.addEventListener("message", (ev) => {
  const { data } = ev.data as OCRPreprocessMessageInput;
  const procImage = binarize(grayscale(data));

  // const procImage = thicken(binarize(grayscale(data)), width, height);
  self.postMessage(procImage satisfies OCRPreprocessMessageOutput, {
    transfer: [procImage.buffer]
  });
});