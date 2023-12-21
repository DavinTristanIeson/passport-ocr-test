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
  for (let i = 0; i < data.length; i += 4) {
    const R = data[i] * RED_INTENCITY_COEF;
    const G = data[i + 1] * GREEN_INTENCITY_COEF;
    const B = data[i + 2] * BLUE_INTENCITY_COEF;
    brightnessSum += Math.min(255, Math.max(0, R + G + B));
  }
  return brightnessSum / ((data.length / 4) * 255);
}

function grayscale(data: Uint8ClampedArray) {
  // Original: 0.2126
  const RED_INTENCITY_COEF = 0.5;
  // Original: 0.7152
  const GREEN_INTENCITY_COEF = 0.5;
  // Original: 0.0722
  const BLUE_INTENCITY_COEF = 0.5;

  for (let i = 0; i < data.length; i += 4) {
    const R = RED_INTENCITY_COEF * data[i];
    const G = GREEN_INTENCITY_COEF * data[i + 1];
    const B = BLUE_INTENCITY_COEF * data[i + 2];

    const brightness = Math.max(0, Math.min(255, R + G + B));
    for (let offset = 0; offset < 3; offset++) {
      data[i + offset] = brightness;
    }
  }
  return data;
}

function binarize(data: Uint8ClampedArray): Uint8ClampedArray {
  const UPPER_THRESHOLD = 128;
  const LOWER_THRESHOLD = 64;
  for (let i = 0; i < data.length; i++) {
    if (data[i] > UPPER_THRESHOLD) {
      data[i] = 255;
    } else if (data[i] < LOWER_THRESHOLD) {
      data[i] = 0;
    }
  }
  return data;
}

function thicken(data: Uint8ClampedArray, width: number, height: number): Uint8ClampedArray {
  const CELL_HEIGHT = 2;
  const CELL_WIDTH = 2 * 4;
  const LOWER_THRESHOLD = 64;
  const actualWidth = width * 4;
  for (let r = 0; r < height; r += CELL_HEIGHT) {
    for (let c = 0; c < actualWidth; c += CELL_WIDTH) {
      let cellColor;
      const ylimit = Math.min(r + CELL_HEIGHT, height);
      const xlimit = Math.min(c + CELL_WIDTH, actualWidth);
      find: for (let y = r; y < ylimit; y++) {
        for (let x = c; x < xlimit; x += 4) {
          if (data[y * actualWidth + x] <= LOWER_THRESHOLD) {
            cellColor = 64;
            break find;
          }
        }
      }
      if (cellColor !== undefined) {
        for (let y = r; y < ylimit; y++) {
          for (let x = c; x < xlimit; x += 4) {
            if (data[y * actualWidth + x] > LOWER_THRESHOLD) {
              for (let off = 0; off < 3; off++) {
                data[y * actualWidth + x + off] = cellColor;
              }
            }
            // data[y * actualWidth + x] = cellColor;
          }
        }
      }
    }
  }
  return data;
}


self.addEventListener("message", (ev) => {
  const { width, height, data } = ev.data as OCRPreprocessMessageInput;
  const brightness = brightnessOf(data);
  const procImage = thicken(binarize(grayscale(data)), width, height);
  // const procImage = thicken(binarize(grayscale(data)), width, height);
  self.postMessage(procImage satisfies OCRPreprocessMessageOutput, {
    transfer: [procImage.buffer]
  });
});