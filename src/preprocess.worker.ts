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

/** Convert the image to grayscale. Desaturated, dark values stay dark while everything else should be light. */
function grayscale(data: Uint8ClampedArray) {
  for (let i = 0; i < data.length; i += 4) {
    // Desaturated values have minor differences between the R, G, and B values.
    // So ``diffRG``, ``diffRB``, and ``diffGB`` should be small (black) for desaturated colors.
    const [R, G, B] = [data[i], data[i + 1], data[i + 2]].map(x => x / 255);
    const [diffRG, diffRB, diffGB] = [R - G, R - B, G - B].map(x => Math.abs(x));
    // Add bias for G and B since the label colors are blue-green, and we don't want them to interfere with the OCR.
    const saturationFactor = R * (diffRG + diffRB) * 0.7 + G * (diffRG + diffGB) * 0.7 + B * (diffRB + diffGB) * 0.7;
    // No need to account for human eyesight with sensitivity factors, just divide by 3.
    // Brightness is necessary to differentiate desaturated dark and desaturated light.
    const brightnessFactor = (R + G + B) / 3;
    const cellColor = Math.min(255, Math.max(0, (brightnessFactor + saturationFactor) * 255));
    for (let offset = 0; offset < 3; offset++) {
      data[i + offset] = cellColor;
    }
  }
  return data;
}

/** Same purpose as binarize in locator.worker.ts */
function binarize(data: Uint8ClampedArray): Uint8ClampedArray {
  const brightness = brightnessOf(data);
  const deviation = deviationOf(data, brightness);
  const UPPER_THRESHOLD = brightness - deviation * 0.5;
  const LOWER_THRESHOLD = brightness - deviation * 1.5;
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