import { createHash } from 'node:crypto';

export const VERIFICATION_RESULT_SCHEMA_VERSION = '1.0';

const MAX_SUMMARY_CHARS = 1_500;
const MAX_ASSERTION_SUMMARY_CHARS = 500;
const MAX_ERROR_CLASS_CHARS = 96;

function truncate(value, maxChars) {
  if (typeof value !== 'string') {
    return '';
  }
  return value.length <= maxChars ? value : `${value.slice(0, Math.max(0, maxChars - 3))}...`;
}

function canonicalize(value) {
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

function normalizedCode(value, field) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new TypeError(`${field} must be a non-empty string`);
  }
  return value.trim().slice(0, 160);
}

function sortedUnique(values) {
  return [...new Set(values)].sort();
}

function normalizeErrorClass(value, passed) {
  if (typeof value !== 'string' || value.trim() === '') {
    return passed ? null : 'VERIFICATION_FAILED';
  }
  const normalized = value
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9_.:-]+/g, '_')
    .slice(0, MAX_ERROR_CLASS_CHARS);
  return normalized || (passed ? null : 'VERIFICATION_FAILED');
}

function normalizeFailedAssertions(value) {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.map((assertion, index) => {
    if (!assertion || typeof assertion !== 'object' || Array.isArray(assertion)) {
      throw new TypeError(`failedAssertions[${index}] must be an object`);
    }
    const item = {
      code: normalizedCode(assertion.code, `failedAssertions[${index}].code`),
      class: normalizedCode(assertion.class ?? 'UNKNOWN', `failedAssertions[${index}].class`),
      summary: truncate(assertion.summary, MAX_ASSERTION_SUMMARY_CHARS),
    };
    if (typeof assertion.evidenceRef === 'string' && assertion.evidenceRef.startsWith('workspace://')) {
      item.evidenceRef = truncate(assertion.evidenceRef, 240);
    }
    return item;
  });
}

function normalizeArtifact(value, legacyOutputHash) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }
  const artifact = {};
  if (typeof value.logicalId === 'string' && value.logicalId.trim() !== '') {
    artifact.logicalId = value.logicalId.trim().slice(0, 200);
  }
  if (Number.isSafeInteger(value.revision) && value.revision >= 0) {
    artifact.revision = value.revision;
  }
  if (typeof value.sha256 === 'string' && /^[a-f0-9]{64}$/i.test(value.sha256)) {
    artifact.sha256 = value.sha256.toLowerCase();
  } else if (typeof legacyOutputHash === 'string' && /^[a-f0-9]{64}$/i.test(legacyOutputHash)) {
    artifact.sha256 = legacyOutputHash.toLowerCase();
  }
  if (Number.isSafeInteger(value.size) && value.size >= 0) {
    artifact.size = value.size;
  }
  return Object.keys(artifact).length > 0 ? artifact : null;
}

function normalizeMetrics(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return {};
  }
  const metrics = {};
  for (const [key, metric] of Object.entries(value).slice(0, 40)) {
    if (!/^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(key)) {
      continue;
    }
    if (
      (typeof metric === 'number' && Number.isFinite(metric)) ||
      (typeof metric === 'string' && metric.length <= 160) ||
      typeof metric === 'boolean'
    ) {
      metrics[key] = metric;
    }
  }
  return metrics;
}

export function normalizeVerificationResult(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError('Verification Result must be an object');
  }
  if (typeof value.passed !== 'boolean') {
    throw new TypeError('Verification Result passed must be boolean');
  }
  const passedAssertionCodes = sortedUnique(
    (Array.isArray(value.passedAssertionCodes) ? value.passedAssertionCodes : [])
      .map((code, index) => normalizedCode(code, `passedAssertionCodes[${index}]`)),
  );
  const failedAssertions = normalizeFailedAssertions(value.failedAssertions);
  const requiredAssertionCount = Number.isSafeInteger(value.requiredAssertionCount) && value.requiredAssertionCount >= 0
    ? value.requiredAssertionCount
    : passedAssertionCodes.length + failedAssertions.length;
  return {
    schemaVersion: VERIFICATION_RESULT_SCHEMA_VERSION,
    profile: typeof value.profile === 'string' && value.profile.trim() !== ''
      ? value.profile.trim().slice(0, 120)
      : 'legacy-verifier-v1',
    profileVersion: typeof value.profileVersion === 'string' && value.profileVersion.trim() !== ''
      ? value.profileVersion.trim().slice(0, 64)
      : '1.0.0',
    passed: value.passed,
    requiredAssertionCount,
    passedAssertionCodes,
    failedAssertions,
    artifact: normalizeArtifact(value.artifact, value.outputHash),
    metrics: normalizeMetrics(value.metrics),
    summary: truncate(value.summary, MAX_SUMMARY_CHARS),
    errorClass: normalizeErrorClass(value.errorClass ?? value.errorSignature, value.passed),
  };
}

export function verificationFingerprint(value) {
  const result = normalizeVerificationResult(value);
  const fingerprintInput = {
    schemaVersion: result.schemaVersion,
    profile: result.profile,
    profileVersion: result.profileVersion,
    passed: result.passed,
    requiredAssertionCount: result.requiredAssertionCount,
    passedAssertionCodes: result.passedAssertionCodes,
    failedAssertions: result.failedAssertions
      .map(({ code, class: assertionClass }) => ({ code, class: assertionClass }))
      .sort((left, right) => `${left.class}:${left.code}`.localeCompare(`${right.class}:${right.code}`)),
    artifactLogicalId: result.artifact?.logicalId ?? null,
    metrics: canonicalize(result.metrics),
    errorClass: result.errorClass,
  };
  return createHash('sha256').update(JSON.stringify(fingerprintInput)).digest('hex');
}
