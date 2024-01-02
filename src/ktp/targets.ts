import { OCRTarget } from "../ocr";
import { correctAlphabet, correctByHistory, correctEnums, mergeCorrectors } from "../ocr/utils";

export type KTPCardOCRTarget = OCRTarget & {
  index: number | null;
};

function correctBloodType(bloodType: string) {
  const bloodTypes = ["A", "B", "AB", "O"];
  bloodTypes.push(...bloodTypes.map(x => `${x}+`), ...bloodTypes.map(x => `${x}-`));
  return bloodTypes.find(bt => bt === bloodType) ?? null;
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

const KTPCardOCRTargets = {
  NIK: {
    key: "NIK",
    index: null,
  } as KTPCardOCRTarget,
  province: {
    key: "province",
    index: null,
    corrector: correctAlphabet({
      withHistory: true,
      withSpaces: true,
    }),
  } as KTPCardOCRTarget,
  regency: {
    key: "regency",
    index: null,
    corrector: correctAlphabet({
      withHistory: true,
      withSpaces: true,
    })
  } as KTPCardOCRTarget,
  city: {
    key: "city",
    index: null,
    corrector: correctAlphabet({
      withHistory: true,
      withSpaces: true,
    })
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
      withSpaces: true,
    })
  } as KTPCardOCRTarget,
  placeOfBirth: {
    key: "placeOfBirth",
    index: null,
    corrector: correctAlphabet({
      withHistory: true,
      withSpaces: true,
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
      withSpaces: true,
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
      withSpaces: true,
    })
  } as KTPCardOCRTarget,
  district: {
    key: "district",
    index: 6,
    corrector: correctAlphabet({
      withHistory: true,
      withSpaces: true,
    })
  } as KTPCardOCRTarget,
  religion: {
    key: "religion",
    index: 7,
    corrector: mergeCorrectors([
      correctAlphabet({
        withHistory: false,
        withSpaces: false,
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
        withSpaces: true,
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
      withSpaces: true,
    })
  } as KTPCardOCRTarget,
  citizenship: {
    key: "citizenship",
    index: 10,
    corrector: correctAlphabet({
      withHistory: true,
      withSpaces: false,
    })
  } as KTPCardOCRTarget,
  validUntil: {
    key: "validUntil",
    index: 11,
    corrector: correctDate,
  } as KTPCardOCRTarget,
}
export default KTPCardOCRTargets;