import { createHash } from 'node:crypto';
import { isLosslessNumber } from 'lossless-json';

interface SignedDecimalInteger {
  sign: -1 | 0 | 1;
  magnitude: string;
}

function canonicalInteger(value: string): SignedDecimalInteger {
  const negative = value.startsWith('-');
  const unsigned = value.replace(/^[+-]/, '').replace(/^0+/, '') || '0';
  if (unsigned === '0') return { sign: 0, magnitude: '0' };
  return { sign: negative ? -1 : 1, magnitude: unsigned };
}

function compareMagnitude(left: string, right: string): number {
  if (left.length !== right.length) return left.length < right.length ? -1 : 1;
  return left === right ? 0 : left < right ? -1 : 1;
}

function addMagnitude(left: string, right: string): string {
  let carry = 0;
  let result = '';
  for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
    const leftDigit = left.charCodeAt(left.length - index - 1) - 48 || 0;
    const rightDigit = right.charCodeAt(right.length - index - 1) - 48 || 0;
    const sum = leftDigit + rightDigit + carry;
    result = String(sum % 10) + result;
    carry = Math.floor(sum / 10);
  }
  if (carry) result = String(carry) + result;
  return result;
}

function subtractMagnitude(larger: string, smaller: string): string {
  let borrow = 0;
  let result = '';
  for (let index = 0; index < larger.length; index += 1) {
    const leftDigit = larger.charCodeAt(larger.length - index - 1) - 48 - borrow;
    const rightDigit = smaller.charCodeAt(smaller.length - index - 1) - 48 || 0;
    if (leftDigit < rightDigit) {
      result = String(leftDigit + 10 - rightDigit) + result;
      borrow = 1;
    } else {
      result = String(leftDigit - rightDigit) + result;
      borrow = 0;
    }
  }
  return result.replace(/^0+/, '') || '0';
}

function addSignedSmall(value: SignedDecimalInteger, delta: number): SignedDecimalInteger {
  if (!Number.isSafeInteger(delta)) throw new TypeError('Numeric exponent adjustment is out of range');
  if (delta === 0) return value;
  const adjustment = canonicalInteger(String(delta));
  if (value.sign === 0) return adjustment;
  if (value.sign === adjustment.sign) {
    return { sign: value.sign, magnitude: addMagnitude(value.magnitude, adjustment.magnitude) };
  }

  const comparison = compareMagnitude(value.magnitude, adjustment.magnitude);
  if (comparison === 0) return { sign: 0, magnitude: '0' };
  if (comparison > 0) {
    return { sign: value.sign, magnitude: subtractMagnitude(value.magnitude, adjustment.magnitude) };
  }
  return { sign: adjustment.sign, magnitude: subtractMagnitude(adjustment.magnitude, value.magnitude) };
}

function formatSignedInteger(value: SignedDecimalInteger): string {
  if (value.sign === 0) return '0';
  return `${value.sign < 0 ? '-' : ''}${value.magnitude}`;
}

function canonicalNumber(token: string): unknown[] {
  const match = /^(-?)(0|[1-9]\d*)(?:\.(\d+))?(?:[eE]([+-]?\d+))?$/.exec(token);
  if (!match) throw new TypeError('Invalid lossless JSON number token');

  const [, signToken, integerPart, fractionPart = '', explicitExponent = '0'] = match;
  let coefficient = `${integerPart}${fractionPart}`.replace(/^0+/, '');
  if (coefficient.length === 0) return ['number', '0'];

  const trailingZeroes = /0+$/.exec(coefficient)?.[0].length ?? 0;
  if (trailingZeroes > 0) coefficient = coefficient.slice(0, -trailingZeroes);
  let exponent = canonicalInteger(explicitExponent);
  exponent = addSignedSmall(exponent, trailingZeroes - fractionPart.length);

  return ['number', signToken === '-' ? '-' : '+', coefficient, formatSignedInteger(exponent)];
}

function canonicalNode(value: unknown, ancestors: WeakSet<object>): unknown[] {
  if (value === null) return ['null'];
  if (typeof value === 'string') return ['string', value];
  if (typeof value === 'boolean') return ['boolean', value];
  if (isLosslessNumber(value)) return canonicalNumber(value.toString());
  if (typeof value === 'number' || typeof value === 'bigint' || typeof value !== 'object') {
    throw new TypeError('Unsupported non-JSON value in canonical request');
  }
  if (ancestors.has(value)) throw new TypeError('Cyclic value in canonical request');

  const prototype = Object.getPrototypeOf(value);
  if (!Array.isArray(value) && prototype !== Object.prototype && prototype !== null) {
    throw new TypeError('Only JSON arrays and plain objects are supported');
  }

  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      return ['array', value.map(item => canonicalNode(item, ancestors))];
    }

    const ownKeys = Reflect.ownKeys(value);
    if (ownKeys.some(key => typeof key !== 'string')) {
      throw new TypeError('Symbol properties are not valid JSON object members');
    }
    const keys = (ownKeys as string[]).sort();
    const entries = keys.map(key => {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor || !descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) {
        throw new TypeError('Only enumerable JSON data properties are supported');
      }
      return [key, canonicalNode(descriptor.value, ancestors)];
    });
    return ['object', entries];
  } finally {
    ancestors.delete(value);
  }
}

export function canonicalizeRequest(value: unknown): string {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError('Canonical request must be a JSON object');
  }
  return JSON.stringify(canonicalNode(value, new WeakSet<object>()));
}

export function hashCanonicalRequest(value: unknown): string {
  return createHash('sha256').update(canonicalizeRequest(value), 'utf8').digest('hex');
}
