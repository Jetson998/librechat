# Provider-Neutral Release Evidence

The release record should preserve these facts without requiring a particular
version-control, build, deployment, or hosting provider:

```json
{
  "source_revision": "",
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
