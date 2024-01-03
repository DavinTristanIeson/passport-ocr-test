import { distance } from "fastest-levenshtein";
import { OCRTarget } from "../ocr";
import { anyCorrectors, correctAlphabet, correctByHistory, correctEnums, mergeCorrectors } from "../ocr/utils";

export type KTPCardOCRTarget = OCRTarget & {
  index: number | null;
};

const bloodTypes = ["A", "B", "AB", "O"];
bloodTypes.push(...bloodTypes.map(x => `${x}+`), ...bloodTypes.map(x => `${x}-`));

function correctBloodType(bloodType: string) {
  const cleanBlood = Array.from(bloodType).filter(chr => "ABO-+".includes(chr)).join('');
  return bloodTypes.find(bt => bt === cleanBlood) ?? null;
}
function correctDate(date: string) {
  const match = date.match(/([0-9]{2})[^a-zA-Z0-9]*([0-9]{2})[^a-zA-Z0-9]*([0-9]{4})/);
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
  const match = rtRw.match(/([0-9]{3})\s*[^a-zA-Z0-9]\s*([0-9]{3})/);
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

function correctStartsWith(expectedTag: string | string[]) {
  return function (value: string) {
    const [tag, ...actualValue] = value.split(' ');
    const candidates = Array.isArray(expectedTag) ? expectedTag : [expectedTag];

    return candidates.find(candidate => distance(tag.toLowerCase(), candidate.toLowerCase()) <= Math.ceil(candidate.length / 3))
      ? actualValue.join('')
      : null;
  }
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
    corrector: correctNIK,
  } as KTPCardOCRTarget,
  province: {
    key: "province",
    index: null,
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
    corrector: mergeCorrectors([
      correctStartsWith("KABUPATEN"),
      correctAlphabet({
        withHistory: true,
        whitelist: ' ',
      }),
    ])
  } as KTPCardOCRTarget,
  city: {
    key: "city",
    index: null,
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
    corrector: correctBloodType,
  } as KTPCardOCRTarget,
  name: {
    key: "name",
    index: 0,
    corrector: correctAlphabet({
      withHistory: true,
      whitelist: ' ',
    })
  } as KTPCardOCRTarget,
  placeOfBirth: {
    key: "placeOfBirth",
    index: null,
    corrector: correctAlphabet({
      withHistory: true,
      whitelist: ' ',
    }),
  } as KTPCardOCRTarget,
  dateOfBirth: {
    key: "dateOfBirth",
    index: null,
    corrector: correctDate,
  } as KTPCardOCRTarget,
  sex: {
    key: "sex",
    index: 2,
    corrector: correctSex,
  } as KTPCardOCRTarget,
  address: {
    key: "address",
    index: 3,
    corrector: correctAlphabet({
      withHistory: true,
      whitelist: ' -',
    })
  } as KTPCardOCRTarget,
  "RT/RW": {
    key: "RT/RW",
    index: 4,
    corrector: correctRTRW,
  } as KTPCardOCRTarget,
  vilage: {
    key: "village",
    index: 5,
    corrector: correctAlphabet({
      withHistory: true,
      whitelist: ' ',
    })
  } as KTPCardOCRTarget,
  district: {
    key: "district",
    index: 6,
    corrector: correctAlphabet({
      withHistory: true,
      whitelist: ' ',
    })
  } as KTPCardOCRTarget,
  religion: {
    key: "religion",
    index: 7,
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
    corrector: correctAlphabet({
      withHistory: true,
      whitelist: ' /-',
    })
  } as KTPCardOCRTarget,
  citizenship: {
    key: "citizenship",
    index: 10,
    corrector: correctAlphabet({
      withHistory: true,
    })
  } as KTPCardOCRTarget,
  validUntil: {
    key: "validUntil",
    index: 11,
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