# Provider-Neutral Failure Taxonomy

The category describes the failing layer, not the product or transport.
Provider-specific error text belongs in `details` in the evidence record.

| Category | Meaning | Recovery rule |
|---|---|---|
| `execution_not_started` | The execution control plane did not start the command | Do not diagnose the command; retry the same gate only after control-plane recovery |
| `execution_failed` | The command started and returned an error | Preserve stdout/stderr and fix the reported command failure |
| `dependency_unavailable` | A required executable, network, or external service is unavailable | Stop and record the dependency; do not substitute an unverified path |
| `authentication_failed` | Credentials were rejected | Repair credentials outside the release artifact, then rerun the same gate |
| `authorization_failed` | The identity lacks the required scope | Request the minimum scope or change the target; do not broaden permissions silently |
| `state_conflict` | Concurrent or incompatible state blocked the action | Re-read the target and invalidate dependent checkpoints |
| `artifact_invalid` | A package, manifest, or required file is incomplete | Rebuild from the exact source revision and verify the manifest |
| `attestation_failed` | Build or artifact proof does not match the source | Stop before deployment and obtain a new immutable proof |
| `target_drift` | Target state changed after a gate passed | Re-run the affected preflight and all dependent gates |
| `deployment_failed` | The bounded write did not complete | Follow the adapter rollback path and record before/after state |
| `acceptance_failed` | Post-change behavior does not meet the contract | Roll back or create a new committed correction; do not hot patch |
| `recording_failed` | The result or evidence could not be persisted | Treat the release as incomplete until the record is durable |

Use `execution_not_started` only when there is direct evidence that the command
never began. An approval response, wrapper error, or timeout before process
creation is not the same as the command's exit status.
