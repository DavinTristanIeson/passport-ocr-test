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

function blur(data: Uint8ClampedArray, width: number, height: number) {
  const CELL_HEIGHT = 3;
  const CELL_WIDTH = 3 * 4;
  const actualWidth = width * 4;
  for (let r = 0; r < height; r += CELL_HEIGHT) {
    for (let c = 0; c < actualWidth; c += CELL_WIDTH) {
      let sumColor = [0, 0, 0];
      const ylimit = Math.min(r + CELL_HEIGHT, height);
      const xlimit = Math.min(c + CELL_WIDTH, actualWidth);
      for (let y = r; y < ylimit; y++) {
        for (let x = c; x < xlimit; x += 4) {
          const idx = y * actualWidth + x;
          for (let i = 0; i < 3; i++) {
            sumColor[i] += data[idx + i];
          }
        }
      }
      const thisCellWidth = (xlimit - c) / 4;
      const thisCellHeight = ylimit - r;
      const cellColor = Array.from(sumColor, (x) => Math.max(0, Math.min(255, Math.round(x / (thisCellWidth * thisCellHeight)))));
      for (let y = r; y < ylimit; y++) {
        for (let x = c; x < xlimit; x += 4) {
          for (let off = 0; off < 3; off++) {
            data[y * actualWidth + x + off] = cellColor[off];
          }
        }
      }
    }
  }
  return data;
}

function grayscale(data: Uint8ClampedArray) {
  // const RED_INTENCITY_COEF = 0.2126;
  // const GREEN_INTENCITY_COEF = 0.7152;
  // const BLUE_INTENCITY_COEF = 0.0722;
  for (let i = 0; i < data.length; i += 4) {
    const diffRG = Math.abs(data[i] - data[i + 1]);
    const diffRB = Math.abs(data[i] - data[i + 2]);
    const diffGB = Math.abs(data[i + 1] - data[i + 2]);
    // const grey = (data[i] * RED_INTENCITY_COEF + data[i + 1] * GREEN_INTENCITY_COEF + data[i + 2] * BLUE_INTENCITY_COEF) / 255;


    // To get an ease-out interpolation on saturation. Less saturation is better.
    const allChannelAbsDiff = Math.max(diffRG, diffRB, diffGB) / 255;
    const saturationFactor = Math.min(1, Math.max(0, Math.sqrt(Math.sqrt(allChannelAbsDiff))));

    // To differentiate desaturated black and desaturated white
    const maxBrightness = Math.max(data[i], data[i + 1], data[i + 2]) / 255;
    const brightnessFactor = Math.min(255, Math.max(0, 255 * Math.pow(2 * maxBrightness, 15)));

    const brightness = Math.min(255, Math.max(0, brightnessFactor + saturationFactor * 255));
    for (let offset = 0; offset < 3; offset++) {
      data[i + offset] = brightness;
    }
  }
  return data;
}

function binarize(data: Uint8ClampedArray): Uint8ClampedArray {
  const UPPER_THRESHOLD = 192;
  const LOWER_THRESHOLD = 160;
  for (let i = 0; i < data.length; i++) {
    if (data[i] > UPPER_THRESHOLD) {
      data[i] = 255;
    } else if (data[i] <= LOWER_THRESHOLD) {
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
  const procImage = thicken(binarize(grayscale(data)), width, height);
  self.postMessage(procImage satisfies OCRPreprocessMessageOutput, {
    transfer: [procImage.buffer]
  });
});