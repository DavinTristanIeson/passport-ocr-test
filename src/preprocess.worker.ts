export interface OCRPreprocessMessageInput {
  width: number;
  height: number;
  data: Uint8ClampedArray;
}
export type OCRPreprocessMessageOutput = Uint8ClampedArray;

function brightnessOf(data: Uint8ClampedArray): number {
  const RED_INTENCITY_COEF = 0.2126;
  const GREEN_INTENCITY_COEF = 0.7152;
  const BLUE_INTENCITY_COEF = 0.0722;
  let brightnessSum = 0;
  const N = (data.length / 4);
  for (let i = 0; i < data.length; i += 4) {
    const R = data[i] * RED_INTENCITY_COEF;
    const G = data[i + 1] * GREEN_INTENCITY_COEF;
    const B = data[i + 2] * BLUE_INTENCITY_COEF;
    brightnessSum += Math.min(255, Math.max(0, R + G + B));
  }
  return brightnessSum / N;
}
function deviationOf(data: Uint8ClampedArray, mean: number): number {
  const RED_INTENCITY_COEF = 0.2126;
  const GREEN_INTENCITY_COEF = 0.7152;
  const BLUE_INTENCITY_COEF = 0.0722;
  const N = (data.length / 4);
  let variance = 0;
  for (let i = 0; i < data.length; i += 4) {
    const R = data[i] * RED_INTENCITY_COEF;
    const G = data[i + 1] * GREEN_INTENCITY_COEF;
    const B = data[i + 2] * BLUE_INTENCITY_COEF;
    const grey = Math.min(255, Math.max(0, R + G + B));
    variance += Math.pow(grey - mean, 2);
  }
  return Math.sqrt(variance / (N - 1));
}

function grayscale(data: Uint8ClampedArray) {
  const brightness = brightnessOf(data) / 255;
  const brightnessFactor = 0.7 + Math.pow(1 - brightness, 2) * 0.3;
  for (let i = 0; i < data.length; i += 4) {
    const [R, G, B] = [data[i], data[i + 1], data[i + 2]];
    const cellColor = Math.min(255, Math.max(0, G * brightnessFactor + B * brightnessFactor));
    for (let offset = 0; offset < 3; offset++) {
      data[i + offset] = cellColor;
    }
  }
  return data;
}

function binarize(data: Uint8ClampedArray): Uint8ClampedArray {
  const brightness = brightnessOf(data);
  const deviation = deviationOf(data, brightness);
  const UPPER_THRESHOLD = brightness - deviation;
  const LOWER_THRESHOLD = brightness - deviation * 2;
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
  const { width, height, data } = ev.data as OCRPreprocessMessageInput;
  const procImage = binarize(grayscale(data));
  self.postMessage(procImage satisfies OCRPreprocessMessageOutput, {
    transfer: [procImage.buffer]
  });
});