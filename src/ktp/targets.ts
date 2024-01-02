import { OCRTarget } from "../ocr";

type KTPCardOCRTarget = OCRTarget;
const KTPCardOCRTargets = {
  name: {
    key: "name",
    bbox: {
      x0: 0,
      y0: 0,
      x1: 1,
      y1: 1,
    }
  } as KTPCardOCRTarget
}
export default KTPCardOCRTargets;