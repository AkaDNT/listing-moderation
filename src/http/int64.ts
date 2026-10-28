import { isLosslessNumber } from 'lossless-json';

const MAX_INT64_TEXT = '9223372036854775807';

export function parsePriceInt64(token: unknown): bigint {
  if (!isLosslessNumber(token)) throw new TypeError('price_vnd must be a JSON number token');

  const text = token.toString();
  if (text === '-0') return 0n;
  if (!/^(0|[1-9][0-9]*)$/.test(text)) {
    throw new TypeError('price_vnd must use nonnegative JSON integer syntax');
  }
  if (text.length > MAX_INT64_TEXT.length ||
      (text.length === MAX_INT64_TEXT.length && text > MAX_INT64_TEXT)) {
    throw new RangeError('price_vnd exceeds signed int64 maximum');
  }
  return BigInt(text);
}
