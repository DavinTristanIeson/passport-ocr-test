import type { OCRPreprocessMessageInput, OCRPreprocessMessageOutput } from "./preprocess.worker";

/** Terrible name. What this does is to turn blue-green colors to black, and the rest to white */
function grayscale(data: Uint8ClampedArray) {
  for (let i = 0; i < data.length; i += 4) {
    const [R, G, B] = [data[i], data[i + 1], data[i + 2]];
    // DO NOT USE MATH.ABS. R - G is different from G - R.
    // If R is high and G is low, then the color is reddish, but if G is high and R is low, then the color is greenish. We don't need reddish colors.
    const absRedDiff = Math.min(Math.max(0, G - R), Math.max(0, B - R));
    // Keep the black values black, and force everything else to white. Function can be viewed on desmos.
    const singleOutBlueGreen = 255 - (Math.pow(absRedDiff / 5, 4) / 255) * 255;

    const brightness = Math.max(0, Math.min(255, singleOutBlueGreen));
    for (let offset = 0; offset < 3; offset++) {
      data[i + offset] = brightness;
    }
  }
  return data;
}

/** Tidy up the canvas. All values above the upper threshold becomes white, and all values below becomes black. */
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

  self.postMessage(procImage satisfies OCRPreprocessMessageOutput, {
    transfer: [procImage.buffer]
  });
});