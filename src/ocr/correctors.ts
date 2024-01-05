import { closest, distance } from "fastest-levenshtein";
import { combineUnique, trimWhitespace } from "./utils";

export function correctByHistory(text: string, history: string[] | undefined) {
  if (!text) return null;
  text = trimWhitespace(text);
  if (history && history.length > 0) {
    const candidate = closest(text, history);
    if (distance(text, candidate) <= Math.ceil(candidate.length / 3)) {
      text = candidate;
    }
  }
  return text;
}

export function correctAlphabet(options?: {
  withHistory?: boolean;
  maxLength?: number;
  whitelist?: string;
}) {
  const withHistory = options?.withHistory ?? true;
  const whitelist = options?.whitelist ?? '';
  return (value: string, history?: string[]) => {
    let text = Array.from(trimWhitespace(value.toUpperCase())).filter(chr => {
      const ascii = chr.charCodeAt(0);
      const isUppercaseAlpha = 65 <= ascii && ascii <= 65 + 26;
      return isUppercaseAlpha || whitelist.includes(chr)
    }).join('').trim();
    if (options?.maxLength !== undefined) {
      text = text.substring(0, options.maxLength);
    }
    if (text.length === 0) {
      return null;
    }
    return withHistory ? correctByHistory(text, history) : text;
  }
}

export function correctEnums(possibleEnums: string[], options?: {
  exact?: boolean;
  history?: boolean;

  spaceInsensitive?: boolean;
}) {
  const enums = possibleEnums.map(value => {
    // Assume case insensitivity, everything is uppercase
    value = value.toUpperCase();
    // If space insensitive, eliminate all spaces
    if (options?.spaceInsensitive) {
      value = value.split(/\s+/).join('');
    }
    return value;
  });
  return (value: string, history?: string[]) => {
    const candidates = (options?.history ?? true) && history ? combineUnique(enums, history) : enums;
    value = trimWhitespace(value.toUpperCase());
    if (options?.spaceInsensitive) {
      // trimWhitespace already removes whitespaces, so only split on regular spaces for space insensitivity.
      value = value.split(' ').join('');
    }

    let corrected = correctByHistory(value, candidates);
    if (options?.exact && !candidates.find(x => x === corrected)) {
      return null;
    }
    // If space insensitive, recover original non-space-insensitive version
    if (options?.spaceInsensitive) {
      const enumIndex = enums.findIndex(enumValue => enumValue === corrected);
      if (enumIndex !== -1) {
        corrected = possibleEnums[enumIndex];
      }
    }
    return corrected;
  }
}

export function correctStartsWith(expectedTag: string | string[]) {
  const candidates = (Array.isArray(expectedTag) ? expectedTag : [expectedTag]).map(x => x.toLowerCase());
  return function (value: string) {
    const [tag, ...actualValue] = trimWhitespace(value).split(' ');
    const insensitiveTag = tag.toLowerCase();
    const candidate = closest(insensitiveTag, candidates);

    return distance(candidate, insensitiveTag) <= Math.ceil(candidate.length / 3)
      ? actualValue.join(' ')
      : null;
  }
}

export function mergeCorrectors(correctors: ((text: string, history: string[]) => string | null)[]) {
  return function (text: string, history: string[]) {
    let temp: string | null = text;
    for (let corrector of correctors) {
      temp = corrector(temp, history);
      if (temp === null) break;
    }
    return temp;
  }
}
export function anyCorrectors(correctors: ((text: string, history: string[]) => string | null)[]) {
  return function (text: string, history: string[]) {
    for (let corrector of correctors) {
      const corrected = corrector(text, history);
      if (corrected !== null) {
        return corrected;
      }
    }
    return null;
  }
}