import type { PassportOCRPreprocessMessageInput, PassportOCRPreprocessMessageOutput } from "./preprocess.worker";

function calculateRedDiffThreshold(data: Uint8ClampedArray) {
  const buffer = new Uint8ClampedArray({ length: Math.floor(data.length / 4) });
  let sum = 0;
  const N = buffer.length;
  const normalizationFactor = 1 / 255;
  for (let i = 0; i < data.length; i += 4) {
    const R = data[i] * normalizationFactor;
    const G = data[i + 1] * normalizationFactor;
    const B = data[i + 2] * normalizationFactor;
    // DO NOT USE MATH.ABS. R - G is different from G - R.
    // If R is high and G is low, then the color is reddish, but if G is high and R is low, then the color is greenish. We don't need reddish colors.
    const absRedDiff = Math.max(Math.max(0, G - R), Math.max(0, B - R));
    sum += absRedDiff;
    buffer[Math.floor(i / 4)] = absRedDiff;
  }
  const mean = sum / N;
  let varianceSum = 0;
  for (let i = 0; i < buffer.length; i++) {
    const diff = mean - buffer[i];
    varianceSum += diff * diff;
  }
  const dev = Math.sqrt(varianceSum / (N - 1));
  return [mean, dev] as const;
}

/** Turn blue-green colors to black, and the rest to white */
function emphasizeBlueGreen(data: Uint8ClampedArray) {
  const [mean, deviation] = calculateRedDiffThreshold(data);
  const THRESHOLD = mean + deviation * 3;
  const normalizationFactor = 1 / 255;
  for (let i = 0; i < data.length; i += 4) {
    const R = data[i] * normalizationFactor;
    const G = data[i + 1] * normalizationFactor;
    const B = data[i + 2] * normalizationFactor;
    const absRedDiff = Math.max(Math.max(0, G - R), Math.max(0, B - R));
    const brightness = (R + G + B) * 0.3333333;

    // Darker colors are preferable, so add a brightness bias
    const cellColor = absRedDiff - (brightness * 0.1) > THRESHOLD ? 0 : 255;
    for (let offset = 0; offset < 3; offset++) {
      data[i + offset] = cellColor;
    }
  }
  return data;
}


self.addEventListener("message", (ev) => {
  const { data } = ev.data as PassportOCRPreprocessMessageInput;
  const procImage = emphasizeBlueGreen(data);

  self.postMessage(procImage satisfies PassportOCRPreprocessMessageOutput, {
    transfer: [procImage.buffer]
  });
});