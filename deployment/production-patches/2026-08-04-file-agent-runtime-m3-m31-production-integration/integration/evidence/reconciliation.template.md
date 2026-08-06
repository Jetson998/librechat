# File Agent Runtime integration reconciliation

Run ID: `fill-after-run`

This is the operator self-review. Fill it from actual command output and
redacted evidence files. Allowed status values are exactly:
`passed`, `failed`, `not_run`, `blocked`, `not_applicable`.

| Requirement | Implementation | Command | Actual result | Evidence | Status |
|---|---|---|---|---|---|
| Production facts recorded without secrets | `PRODUCTION_INTEGRATION_FACTS.md` | facts review | fill | facts document | not_run |
| Runtime and harness revisions are both bound | `.env.integration`, `integration-up.sh` | `integration-up.sh` | fill | `integration-revisions.txt` | not_run |
| Runtime/Connector paths unchanged between revisions | `integration-up.sh` ancestor/diff gate | `git diff` check | fill | revision gate output | not_run |
| Clean-machine environment creation | `compose.integration.yaml`, `.env.integration.example` | `integration-up.sh` | fill | Compose/image evidence | not_run |
| Reviewed API overlay is loaded | `Dockerfile.api`, startup marker | `integration-status.sh` | fill | API marker + manifest | not_run |
| Real CodeAPI image is used | `CODEAPI_IMAGE` and exact image ID | `import-codeapi-image.sh` | fill | image identity | blocked |
| Runtime sends real `/exec` contract | `librechat-codeapi-transport.js` | developer E2E | fill | `codeapi-audit.ndjson` | not_run |
| DOCX artifact identity is complete | Runtime transport + Connector | developer E2E | fill | E2E evidence | not_run |
| GPT selected model reaches Fake Relay | Fake Relay log | developer E2E | fill | `fake-relay-requests.ndjson` | not_run |
| Fable selected model reaches Fake Relay | Fake Relay log | developer E2E | fill | `fake-relay-requests.ndjson` | not_run |
| Native/negative routing is correct | developer-owned negative E2E | developer E2E | fill | redacted logs | not_run |
| Cleanup removes test data and secrets | `integration-down.sh` | `integration-down.sh` | fill | post-clean status | not_run |
| Production write occurred | out of scope | no production command | must remain false | review record | passed |

## Mandatory answers

```text
real API bridge loaded: fill
real CodeAPI image used: fill
real /exec request body captured: fill
real artifact returned and verified: fill
selected model reached Fake Relay: fill
failure path exercised: developer-owned
production secret/customer data used: false
production write: false
unverified items: fill
blockers: fill
```
