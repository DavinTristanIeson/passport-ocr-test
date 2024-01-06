import { closest, distance } from "fastest-levenshtein";
import { OCRHistory, OCRResult, type OCRTarget } from "../ocr";
import { correctAlphabet } from "../ocr/correctors";
import { Bbox } from "tesseract.js";
import { combineUnique, pad0 } from "../ocr/utils";

export type PassportOCRTarget = OCRTarget & {
  isDate?: boolean;
  bbox: Bbox;
}
export type PassportOCRResult = OCRResult<typeof PassportOCRTargets>;
export type PassportOCRHistory = OCRHistory<typeof PassportOCRTargets>;

const MONTHS = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];

/** Corrects passport dates. Day and year must be numbers, but there's a loose word comparison for the month part. */
function correctPassportDate(value: string): string | null {
  value = value.split(/\s+/).join('');
  // Sometimes, letters in the month part are interpreted as digits (O <=> 0) so we cannot simply use \w.
  const match = value.match(/([0-9]{1,2})([\d\w]{3})([0-9]{4})/);
  if (!match) return null;
  const day = parseInt(match[1]);
  const rawMonth = match[2].toUpperCase();
  const year = parseInt(match[3]);
  const closestMonth = closest(rawMonth, MONTHS);
  const month = distance(rawMonth, closestMonth) <= 2 ? closestMonth : null;
  if (isNaN(day) || isNaN(year) || !month) {
    return null;
  }
  if (day < 1 || day > 31 || year < 1900 || year > 2200) {
    return null;
  }
  return `${pad0(day)} ${month} ${year}`;
}

function correctPassportNumber(value: string) {
  return Array.from(value.toUpperCase()).filter(chr => {
    const ascii = chr.charCodeAt(0);
    const isNumeric = 48 <= ascii && ascii <= 48 + 9;
    const isUppercaseAlpha = 65 <= ascii && ascii <= 65 + 26;
    return isNumeric || isUppercaseAlpha;
  }).join('').substring(0, 8);
}

/** Corrects passport types.
 * 
 *  If the passport type is a capital letter then it is returned, but if it isn't, null. */
function correctPassportType(value: string) {
  if (!value) return null;
  let type: string | undefined;
  for (const chr of value.toUpperCase()) {
    const ascii = chr.charCodeAt(0);
    if (65 <= ascii && ascii <= 65 + 26) {
      type = chr;
      break;
    }
  }
  if (type) {
    return type;
  }
  return null;
}

/** Corrects sex values outputted by the OCR. Values should be formatted as AA or A/A to be valid. */
function correctSex(value: string, history: string[] | undefined) {
  if (!value) return null;
  const match = value.toUpperCase().match(/([A-Z])\/*([A-Z])/);
  if (!match) return null;
  let sex = `${match[1]}/${match[2]}`;
  const enums = combineUnique(["L/M", "P/F"], history ?? []);
  const closestMatch = closest(sex, enums);
  if (distance(sex, closestMatch) <= 1) {
    sex = closestMatch;
  }
  return sex;
}

/** Bounding boxes for targetting relevant sections in the passport. */
const PassportOCRTargets = {
  /* 30 Dec 2023: Type and RegNumber is not necessary at the moment. This can be uncommented at any time if you want to toggle them back on */
  // type: {
  //   key: "type",
  //   bbox: {
  //     x0: 0.000,
  //     y0: 0.060,
  //     x1: 0.230,
  //     y1: 0.200,
  //   },
  //   corrector: correctPassportType,
  // } as PassportOCRTarget,
  countryCode: {
    key: "countryCode",
    bbox: {
      x0: 0.240,
      y0: 0.060,
      x1: 0.560,
      y1: 0.200
    },
    hasHistory: true,
    corrector: correctAlphabet({
      whitelist: ' ',
      withHistory: true,
      maxLength: 3,
    }),
  } as PassportOCRTarget,
  passportNumber: {
    key: "passportNumber",
    hasHistory: false,
    bbox: {
      x0: 0.600,
      y0: 0.060,
      x1: 1,
      y1: 0.230,
    },
    corrector: correctPassportNumber,
  } as PassportOCRTarget,
  fullName: {
    key: "fullName",
    hasHistory: false,
    bbox: {
      x0: 0.000,
      y0: 0.230,
      x1: 0.820,
      y1: 0.380,
    },
    corrector: correctAlphabet({
      withHistory: false,
      whitelist: ' ',
    }),
  } as PassportOCRTarget,
  sex: {
    key: "sex",
    hasHistory: true,
    bbox: {
      x0: 0.820,
      y0: 0.230,
      x1: 1,
      y1: 0.380,
    },
    corrector: correctSex,
  } as PassportOCRTarget,
  nationality: {
    key: "nationality",
    hasHistory: true,
    bbox: {
      x0: 0.000,
      y0: 0.380,
      x1: 0.780,
      y1: 0.520,
    },
    corrector: correctAlphabet({
      withHistory: true,
      whitelist: ' ',
    }),
  } as PassportOCRTarget,
  dateOfBirth: {
    key: "dateOfBirth",
    hasHistory: false,
    bbox: {
      x0: 0.000,
      y0: 0.540,
      x1: 0.350,
      y1: 0.680,
    },
    isDate: true,
    corrector: correctPassportDate,
  } as PassportOCRTarget,
  sex2: {
    key: "sex",
    bbox: {
      x0: 0.360,
      y0: 0.540,
      x1: 0.540,
      y1: 0.680,
    },
    corrector: correctSex,
  } as PassportOCRTarget,
  placeOfBirth: {
    key: "placeOfBirth",
    hasHistory: true,
    bbox: {
      x0: 0.560,
      y0: 0.540,
      x1: 1,
      y1: 0.680
    },
    corrector: correctAlphabet({
      withHistory: true,
      whitelist: ' ',
    }),
  } as PassportOCRTarget,
  dateOfIssue: {
    key: "dateOfIssue",
    hasHistory: false,
    bbox: {
      x0: 0.000,
      y0: 0.700,
      x1: 0.350,
      y1: 0.840,
    },
    isDate: true,
    corrector: correctPassportDate,
  } as PassportOCRTarget,
  dateOfExpiry: {
    key: "dateOfExpiry",
    hasHistory: false,
    bbox: {
      x0: 0.640,
      y0: 0.700,
      x1: 1,
      y1: 0.840,
    },
    isDate: true,
    corrector: correctPassportDate,
  } as PassportOCRTarget,
  // regNumber: {
  //   key: "regNumber",
  //   hasHistory: false,
  //   bbox: {
  //     x0: 0.000,
  //     y0: 0.860,
  //     x1: 0.500,
  //     y1: 1,
  //   },
  // } as PassportOCRTarget,
  issuingOffice: {
    key: "issuingOffice",
    hasHistory: true,
    bbox: {
      x0: 0.500,
      y0: 0.860,
      x1: 1,
      y1: 1,
    },
    corrector: correctAlphabet({
      withHistory: true,
      whitelist: ' ',
    }),
  } as PassportOCRTarget
};

export default PassportOCRTargets;
