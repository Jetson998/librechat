# Provider-Neutral Release Evidence

The release record should preserve these facts without requiring a particular
version-control, build, deployment, or hosting provider:

```json
{
  "source_revision": "",
  "release_plan": {},
  "build_attestation": {},
  "artifact_digest": {},
  "runtime_snapshot": {},
  "backup_reference": {},
  "acceptance_result": {},
  "rollback_reference": {},
  "unresolved_issues": []
}
```

Provider-specific identifiers belong inside the corresponding object. For
example, a Git commit, CI run, container digest, package checksum, or mobile
build number can be recorded without becoming a generic protocol requirement.

The record is incomplete when a required object is absent. A value such as
`not_applicable` must include a reason and be allowed by the selected project
mode.

For a production batch, `release_plan` should identify the deterministic plan
derived from accumulated paths. Build attestation should cover the plan's build
and test requirements and state that the production target was not used as the
build environment.

Business acceptance evidence is conceptual rather than tied to a fixed field
layout. It should make the following facts recoverable:

- whether light or heavy acceptance was selected and why;
- which business path, role, interface, data boundary, or service was covered;
- which evidence was reused and which checks were newly executed;
- the result, important warnings, and detailed evidence location;
- whether the release may continue, must stop, or should roll back.

Reused evidence is valid only when it matches the relevant source revision,
artifact, configuration, and environment assumptions. Detailed logs may remain
outside the release record when the record points to them and keeps a compact
decision summary.
