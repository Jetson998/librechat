import { actionSignature } from './action-envelope.js';
import { normalizeVerificationResult } from './verification-result.js';

function sortedUnique(values) {
  return [...new Set((values ?? []).filter((value) => typeof value === 'string' && value !== ''))].sort();
}

function setStrictlyReduced(previousValues, currentValues) {
  const previous = new Set(previousValues);
  const current = new Set(currentValues);
  return current.size < previous.size && [...current].every((value) => previous.has(value));
}

function setStrictlyIncreased(previousValues, currentValues) {
  const previous = new Set(previousValues);
  const current = new Set(currentValues);
  return current.size > previous.size && [...previous].every((value) => current.has(value));
}

export function buildProgressVector({
  phase,
  verification,
  closedPlanNodeIds = [],
  scriptHash = null,
  artifactHash = null,
}) {
  const normalized = normalizeVerificationResult(verification);
  return {
    phase: typeof phase === 'string' ? phase : null,
    targetArtifactLogicalId: normalized.artifact?.logicalId ?? null,
    verificationProfile: normalized.profile,
    verificationProfileVersion: normalized.profileVersion,
    passedRequiredAssertionCodes: sortedUnique(normalized.passedAssertionCodes),
    failedRequiredAssertionCodes: sortedUnique(
      normalized.failedAssertions.map((assertion) => assertion.code),
    ),
    normalizedErrorClass: normalized.errorClass,
    closedPlanNodeIds: sortedUnique(closedPlanNodeIds),
    scriptHash: typeof scriptHash === 'string' ? scriptHash : null,
    artifactHash: typeof artifactHash === 'string' ? artifactHash : normalized.artifact?.sha256 ?? null,
  };
}

export function evaluateProgress(previous, current) {
  if (!previous) {
    return { progressed: true, reason: 'initial_verification' };
  }
  if (
    setStrictlyReduced(
      previous.failedRequiredAssertionCodes ?? [],
      current.failedRequiredAssertionCodes ?? [],
    )
  ) {
    return { progressed: true, reason: 'failed_assertions_reduced' };
  }
  if (
    setStrictlyIncreased(
      previous.passedRequiredAssertionCodes ?? [],
      current.passedRequiredAssertionCodes ?? [],
    )
  ) {
    return { progressed: true, reason: 'passed_assertions_increased' };
  }
  if (
    setStrictlyIncreased(
      previous.closedPlanNodeIds ?? [],
      current.closedPlanNodeIds ?? [],
    )
  ) {
    return { progressed: true, reason: 'plan_nodes_closed' };
  }
  return { progressed: false, reason: 'required_assertions_unchanged' };
}

export function repairActionSignature(plan) {
  return actionSignature(plan);
}
