import { distance } from "fastest-levenshtein";
import { OCRTarget } from "../ocr";
import { anyCorrectors, correctAlphabet, correctAlphanumeric, correctByHistory, correctEnums, mergeCorrectors } from "../ocr/correctors";
import { correctStartsWith } from "../ocr/correctors";
import { trimWhitespace } from "../ocr/utils";

export type KTPCardOCRTarget = OCRTarget & {
  index: number | null;
};

// Constant for blood type, contain all + and - variants of the basic four types.
const bloodTypes = ["A", "B", "AB", "O"];
bloodTypes.push(...bloodTypes.map(x => `${x}+`), ...bloodTypes.map(x => `${x}-`));

function correctBloodType(bloodType: string) {
  // Remove all characters that are not A, B, O, -, or +. We need to find an exact match
  const cleanBlood = Array.from(bloodType).filter(chr => "ABO-+".includes(chr)).join('');
  return bloodTypes.find(bt => bt === cleanBlood) ?? null;
}

export const KTP_DATE_REGEX = /([0-9]{2})[^a-zA-Z0-9]*([0-9]{2})[^a-zA-Z0-9]*([0-9]{4})/;

// Single isolated characters at the front of the string should be ignored as that's probably part of the colon/label
export function correctStrayCharacter(value: string) {
  const split = value.trim().split(':', 2);
  if (split.length > 1) {
    // ...OCR might hallucinate a colon near the end.
    value = (split[0].length > split[1].length ? split[0] : split[1]).trim();
  }
  const textSections = value.split(/\s+/);
  while (textSections.length > 0 && textSections[0].length <= 1) {
    textSections.shift();
  }
  return textSections.length === 0 ? null : textSections.join(' ');
}

function correctDate(date: string) {
  const match = date.match(KTP_DATE_REGEX);
  if (!match) {
    return null;
  }
  const day = parseInt(match[1]);
  const month = parseInt(match[2]);
  const year = parseInt(match[3]);

  const dayInvalid = isNaN(day) || day < 1 || day > 31;
  const monthInvalid = isNaN(month) || month < 1 || month > 12;
  const yearInvalid = isNaN(year) || year < 1900 || year > 2200;
  if (dayInvalid || monthInvalid || yearInvalid) {
    return null;
  }
  return `${match[1]}-${match[2]}-${match[3]}`;
}

function correctRTRW(rtRw: string) {
  // RT or RW might not exist and be replaced with hyphen.
  const match = rtRw.match(/([0-9]{3}|-)[^a-zA-Z0-9]*([0-9]{3}|-)/);
  if (!match) {
    return null;
  }
  const RT = match[1];
  const RW = match[2];
  return `${RT}/${RW}`;
}

function correctSex(value: string, history: string[]) {
  const enums = ["PEREMPUAN", "LAKI-LAKI", "LAKI"];
  // SOURCE: https://www.kompas.com/tren/read/2021/06/06/181500165/penjelasan-dukcapil-soal-alur-dan-jenis-kelamin-ktp-el-transgender
  const closest = correctByHistory(value.toUpperCase(), enums);
  const result = enums.find((candidate) => candidate === closest) ?? null;
  // Sometimes, the OCR'ed field doesn't have a hyphen between the two LAKIs, so it just becomes "LAKI LAKI", which when split becomes LAKI.
  return (result === "LAKI" ? "LAKI-LAKI" : result);
}

function correctJakartaTerritory(value: string) {
  // And of course there must be an exception for Jakarta.
  // Jakarta doesn't start with Kabupaten or Kota.
  const [tag, ...actualValue] = value.split(' ');
  if (distance(tag.toUpperCase(), "JAKARTA") <= Math.ceil(8 / 3)) {
    return `JAKARTA ${actualValue.join(' ').toUpperCase()}`;
  }
  return null;
}

function correctNIK(value: string) {
  const corrected = Array.from(value).filter(x => {
    const ascii = x.charCodeAt(0);
    return 48 <= ascii && ascii <= 48 + 9;
  }).join('');
  return (corrected.length === 0 ? null : corrected);
}

function correctNationality(value: string, history: string[]) {
  if (value.includes("WNI") || distance(value, "WNI") <= 1 || value.includes("WM")) {
    return "WNI";
  }
  return correctByHistory(value, history);
}

const KTPCardOCRTargets = {
  NIK: {
    key: "NIK",
    index: null,
    hasHistory: false,
    corrector: correctNIK,
  } as KTPCardOCRTarget,
  province: {
    key: "province",
    index: null,
    hasHistory: true,
    corrector: mergeCorrectors([
      // Correct alphabet will clean the input up first, and then startsWith will check if the string matches the condition, and finally the result is matched with historical data
      correctAlphabet({
        withHistory: false,
        whitelist: ' ',
      }),
      correctStartsWith("PROVINSI"),
      correctByHistory,
    ])
  } as KTPCardOCRTarget,
  regency: {
    key: "regency",
    index: null,
    hasHistory: true,
    corrector: mergeCorrectors([
      correctAlphabet({
        withHistory: false,
        whitelist: ' ',
      }),
      anyCorrectors([
        correctStartsWith("KABUPATEN"),
        // https://id.wikipedia.org/wiki/Daftar_kabupaten_dan_kota_administrasi_di_Daerah_Khusus_Ibukota_Jakarta
        // KEPULAUAN SERIBU
        correctEnums(["KEPULAUAN SERIBU"], {
          spaceInsensitive: true,
          exact: true,
          history: false,
        }),
      ]),
      correctByHistory,
    ])
  } as KTPCardOCRTarget,
  city: {
    key: "city",
    index: null,
    hasHistory: true,
    corrector: mergeCorrectors([
      correctAlphabet({
        withHistory: false,
        whitelist: ' ',
      }),
      anyCorrectors([
        correctStartsWith("KOTA"),
        // https://id.wikipedia.org/wiki/Daftar_kabupaten_dan_kota_administrasi_di_Daerah_Khusus_Ibukota_Jakarta
        // Semua daerah Jakarta kecuali Kepulauan Seribu
        correctJakartaTerritory,
      ]),
      correctByHistory,
    ])
  } as KTPCardOCRTarget,
  bloodType: {
    key: "bloodType",
    index: null,
    hasHistory: false,
    corrector: correctBloodType,
  } as KTPCardOCRTarget,
  name: {
    key: "name",
    index: 0,
    hasHistory: false,
    corrector: mergeCorrectors([
      correctStrayCharacter,
      correctAlphabet({
        withHistory: true,
        whitelist: ' ',
      }),
    ])
  } as KTPCardOCRTarget,
  placeOfBirth: {
    key: "placeOfBirth",
    index: null,
    hasHistory: true,
    corrector: mergeCorrectors([
      correctStrayCharacter,
      correctAlphabet({
        withHistory: true,
        whitelist: ' ',
      }),
    ]),
  } as KTPCardOCRTarget,
  dateOfBirth: {
    key: "dateOfBirth",
    index: null,
    hasHistory: false,
    corrector: correctDate,
  } as KTPCardOCRTarget,
  sex: {
    key: "sex",
    index: null,
    hasHistory: false,
    corrector: mergeCorrectors([
      correctAlphabet({
        whitelist: '-'
      }),
      correctSex
    ]),
  } as KTPCardOCRTarget,
  address: {
    key: "address",
    index: 3,
    hasHistory: false,
    corrector: mergeCorrectors([
      correctStrayCharacter,
      correctAlphanumeric({
        withHistory: true,
        whitelist: ' /.',
      }),
    ])
  } as KTPCardOCRTarget,
  "RT/RW": {
    key: "RT/RW",
    index: 4,
    hasHistory: false,
    corrector: correctRTRW,
  } as KTPCardOCRTarget,
  village: {
    key: "village",
    index: 5,
    hasHistory: true,
    corrector: mergeCorrectors([
      correctStrayCharacter,
      correctAlphabet({
        withHistory: true,
        whitelist: ' ',
      }),
    ])
  } as KTPCardOCRTarget,
  district: {
    key: "district",
    index: 6,
    hasHistory: true,
    corrector: mergeCorrectors([
      correctStrayCharacter,
      correctAlphabet({
        withHistory: true,
        whitelist: ' ',
      }),
    ])
  } as KTPCardOCRTarget,
  religion: {
    key: "religion",
    index: 7,
    hasHistory: true,
    corrector: mergeCorrectors([
      correctAlphabet({
        withHistory: false,
      }),
      correctEnums([
        // SOURCE: https://news.detik.com/berita/d-2424439/hanya-6-agama-yang-boleh-ditulis-di-e-ktp
        "BUDDHA", "HINDU", "ISLAM", "KATOLIK", "KONGHUCU", "KRISTEN", "PROTESTAN",
        // SOURCE: https://www.pagesfix.com/contoh-terjemahan-ktp-dalam-bahasa-inggris-kartu-tanda-penduduk/
        "BUDDHISM", "CATHOLICISM", "CHRISTIANITY", "CONFUCIANISM", "HINDUISM", "ISLAM", "PROTESTANTISM",
      ], {
        history: true,
        exact: true,
        spaceInsensitive: true,
      })
    ])
  } as KTPCardOCRTarget,
  marriageStatus: {
    key: "marriageStatus",
    index: 8,
    hasHistory: true,
    corrector: mergeCorrectors([
      correctStrayCharacter,
      correctAlphabet({
        withHistory: false,
        whitelist: ' ',
      }),
      correctEnums([
        // SOURCE: https://news.detik.com/berita/d-6457733/cara-dan-syarat-mengubah-status-ktp-menjadi-kawin
        "BELUM KAWIN", "KAWIN", "CERAI HIDUP", "CERAI MATI",
        // SOURCE: https://www.pagesfix.com/contoh-terjemahan-ktp-dalam-bahasa-inggris-kartu-tanda-penduduk/
        "SINGLE", "MARRIED", "DIVORCED", "WIDOWED"
      ], {
        history: true,
        exact: true,
        spaceInsensitive: true,
      }),
    ]),
  } as KTPCardOCRTarget,
  occupation: {
    key: "occupation",
    index: 9,
    hasHistory: true,
    corrector: mergeCorrectors([
      correctStrayCharacter,
      correctAlphabet({
        withHistory: true,
        whitelist: ' ',
      }),
    ])
  } as KTPCardOCRTarget,
  citizenship: {
    key: "citizenship",
    index: 10,
    hasHistory: true,
    corrector: mergeCorrectors([
      correctStrayCharacter,
      correctAlphabet({
        withHistory: false,
      }),
      correctNationality,
    ])
  } as KTPCardOCRTarget,
  validUntil: {
    key: "validUntil",
    index: 11,
    hasHistory: false,
    corrector: mergeCorrectors([
      correctStrayCharacter,
      anyCorrectors([
        correctDate,
        correctEnums(["SEUMUR HIDUP"], {
          exact: true,
          history: false,
        })
      ])
    ]),
  } as KTPCardOCRTarget,
}
export default KTPCardOCRTargets;