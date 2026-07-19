# Project Adapter Contract

The generic Skill defines the release protocol. A project adapter defines the
concrete way to satisfy it.

Required adapter fields:

- project identity and repository boundary;
- supported risk modes and required gates;
- allowed `not_applicable` gates and required reasons;
- source and artifact paths;
- read-only target preflight command;
- bounded apply/deploy command;
- acceptance command;
- critical business paths and risk triggers;
- rules for selecting light or heavy acceptance, reusing evidence, and asking
  for human confirmation;
- rollback command or reference;
- evidence and checkpoint locations.

The adapter must not contain secrets. Runtime credentials come from the
operator's environment or secret store. Adapter commands must fail closed and
must write compact summaries while placing detailed evidence in files.

`not_applicable` is a declared capability of a mode, not a per-run bypass. A
run may select it only with a reason recorded in the checkpoint and release
record.

## Business acceptance contract

The adapter must keep business acceptance inside the release decision while
choosing the smallest sufficient check set. It should explain which changed
paths receive light acceptance and which changes require heavy acceptance.

Light acceptance normally checks the changed path, one important guardrail,
and a bounded post-write smoke. Heavy acceptance is reserved for data,
identity, billing, routing, core file flows, multi-service changes, weak
rollback, or other high-impact behavior.

Existing evidence may be reused when it belongs to the same source revision,
artifact, configuration, and relevant environment assumptions. The release
record should preserve the decision, scope, result, warnings, evidence
location, and continue-or-rollback outcome without forcing a provider-specific
field layout.

The adapter must not turn business acceptance into a full server audit, a
security scan, a load test, a cleanup job, or a repeated model conversation.
