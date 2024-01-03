import { distance } from "fastest-levenshtein";
import { OCRTarget } from "../ocr";
import { anyCorrectors, correctAlphabet, correctByHistory, correctEnums, mergeCorrectors } from "../ocr/correctors";
import { correctStartsWith } from "../ocr/correctors";

export type KTPCardOCRTarget = OCRTarget & {
  index: number | null;
};

const bloodTypes = ["A", "B", "AB", "O"];
bloodTypes.push(...bloodTypes.map(x => `${x}+`), ...bloodTypes.map(x => `${x}-`));

function correctBloodType(bloodType: string) {
  const cleanBlood = Array.from(bloodType).filter(chr => "ABO-+".includes(chr)).join('');
  return bloodTypes.find(bt => bt === cleanBlood) ?? null;
}

export const KTP_DATE_REGEX = /([0-9]{2})[^a-zA-Z0-9]*([0-9]{2})[^a-zA-Z0-9]*([0-9]{4})/;
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
  const match = rtRw.match(/([0-9]{3})[^a-zA-Z0-9]*([0-9]{3})/);
  if (!match) {
    return null;
  }
  const RT = match[1];
  const RW = match[2];
  return `${RT}/${RW}`;
}

function correctSex(value: string, history: string[]) {
  const sex = value.split(' ')[0];
  if (!sex) return null;
  // SOURCE: https://www.kompas.com/tren/read/2021/06/06/181500165/penjelasan-dukcapil-soal-alur-dan-jenis-kelamin-ktp-el-transgender
  return correctByHistory(sex.toUpperCase(), ["PEREMPUAN", "LAKI-LAKI"]);
}

function correctJakartaTerritory(value: string) {
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
      correctStartsWith("PROVINSI"),
      correctAlphabet({
        withHistory: true,
        whitelist: ' ',
      }),
    ])
  } as KTPCardOCRTarget,
  regency: {
    key: "regency",
    index: null,
    hasHistory: true,
    corrector: mergeCorrectors([
      anyCorrectors([
        correctStartsWith("KABUPATEN"),
        correctJakartaTerritory,
      ]),
      correctAlphabet({
        withHistory: true,
        whitelist: ' ',
      }),
    ])
  } as KTPCardOCRTarget,
  city: {
    key: "city",
    index: null,
    hasHistory: true,
    corrector: mergeCorrectors([
      correctStartsWith("KOTA"),
      correctAlphabet({
        withHistory: true,
        whitelist: ' ',
      }),
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
    corrector: correctAlphabet({
      withHistory: true,
      whitelist: ' ',
    })
  } as KTPCardOCRTarget,
  placeOfBirth: {
    key: "placeOfBirth",
    index: null,
    hasHistory: true,
    corrector: correctAlphabet({
      withHistory: true,
      whitelist: ' ',
    }),
  } as KTPCardOCRTarget,
  dateOfBirth: {
    key: "dateOfBirth",
    index: null,
    hasHistory: false,
    corrector: correctDate,
  } as KTPCardOCRTarget,
  sex: {
    key: "sex",
    index: 2,
    hasHistory: false,
    corrector: correctSex,
  } as KTPCardOCRTarget,
  address: {
    key: "address",
    index: 3,
    hasHistory: false,
    corrector: correctAlphabet({
      withHistory: false,
      whitelist: ' -',
    })
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
    corrector: correctAlphabet({
      withHistory: true,
      whitelist: ' ',
    })
  } as KTPCardOCRTarget,
  district: {
    key: "district",
    index: 6,
    hasHistory: true,
    corrector: correctAlphabet({
      withHistory: true,
      whitelist: ' ',
    })
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
      })
    ])
  } as KTPCardOCRTarget,
  marriageStatus: {
    key: "marriageStatus",
    index: 8,
    hasHistory: true,
    corrector: mergeCorrectors([
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
      }),
    ]),
  } as KTPCardOCRTarget,
  occupation: {
    key: "occupation",
    index: 9,
    hasHistory: true,
    corrector: correctAlphabet({
      withHistory: true,
      whitelist: ' /',
    })
  } as KTPCardOCRTarget,
  citizenship: {
    key: "citizenship",
    index: 10,
    hasHistory: true,
    corrector: correctAlphabet({
      withHistory: true,
    })
  } as KTPCardOCRTarget,
  validUntil: {
    key: "validUntil",
    index: 11,
    hasHistory: false,
    corrector: anyCorrectors([
      correctDate,
      correctEnums(["SEUMUR HIDUP"], {
        exact: true,
        history: false,
      })
    ]),
  } as KTPCardOCRTarget,
}
export default KTPCardOCRTargets;