import { createHash } from 'node:crypto';

export function clone(value) {
  return structuredClone(value);
}

export function canonicalize(value) {
  if (Array.isArray(value)) {
    return value.map(canonicalize);
  }
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, canonicalize(value[key])]),
    );
  }
  return value;
}

export function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

export function digestJson(value) {
  return sha256(JSON.stringify(canonicalize(value)));
}

export function requiredString(value, name) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new TypeError(`${name} is required`);
  }
  return value.trim();
}

export function opaqueRef(kind, value) {
  return `${kind}_${sha256(`${kind}:${requiredString(value, kind)}`).slice(0, 32)}`;
}
