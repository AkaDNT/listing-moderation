import { isLosslessNumber, parse, stringify } from 'lossless-json';

const MAX_JSON_DEPTH = 128;

export function parseJson(text: string): unknown {
  assertJsonDepth(text);
  return parse(text);
}

export function stringifyJson(value: unknown): string {
  assertSerializable(value, new WeakSet<object>());
  const output = stringify(value);
  if (output === undefined) throw new TypeError('Value is not JSON serializable');
  return output;
}

function assertJsonDepth(text: string): void {
  let depth = 0;
  let inString = false;
  let escaped = false;

  for (const char of text) {
    if (inString) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') inString = false;
      continue;
    }

    if (char === '"') inString = true;
    else if (char === '{' || char === '[') {
      depth += 1;
      if (depth > MAX_JSON_DEPTH) throw new SyntaxError('JSON nesting limit exceeded');
    } else if (char === '}' || char === ']') depth -= 1;
  }
}

function assertSerializable(value: unknown, ancestors: WeakSet<object>): void {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return;

  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TypeError('Non-finite numbers are not valid API JSON');
    if (Number.isInteger(value) && !Number.isSafeInteger(value)) {
      throw new TypeError('Unsafe integer Number cannot be serialized without precision loss');
    }
    return;
  }

  if (typeof value === 'bigint' || isLosslessNumber(value)) return;
  if (typeof value !== 'object') throw new TypeError('Unsupported API JSON value');

  if (value instanceof Date) {
    if (!Number.isFinite(value.getTime())) throw new TypeError('Invalid Date cannot be serialized');
    return;
  }

  if (ancestors.has(value)) throw new TypeError('Cyclic API JSON value');
  const prototype = Object.getPrototypeOf(value);
  if (!Array.isArray(value) && prototype !== Object.prototype && prototype !== null) {
    throw new TypeError('Only plain objects are valid API JSON values');
  }

  ancestors.add(value);
  try {
    const children = Array.isArray(value) ? value : Object.values(value);
    for (const child of children) assertSerializable(child, ancestors);
  } finally {
    ancestors.delete(value);
  }
}
