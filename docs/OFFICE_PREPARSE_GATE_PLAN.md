# Office Pre-parse Gate Plan

Date: 2026-07-19

Status: approved for implementation; production not changed.

## Incident

Conversation `003971ae-274f-40a1-96a3-e05ab46b8f35` attached two DOCX and two
XLSX files in one user turn. The files were stored with valid CodeAPI
references, but neither GPT nor Fable invoked the code tool. Both GPT attempts
persisted an empty assistant sibling; the Fable attempt persisted reasoning
without a final answer. CodeAPI received no `/exec` request for the turn.

The upload and artifact pipelines are healthy. The missing guarantee is between
agent initialization and model execution: an Office attachment is mounted for
code execution, but the model is still responsible for deciding whether to
read it.

## Decision

Keep the existing LibreChat file pipeline and add one request-scoped pre-parse
gate before the model run:

1. Select only Office files explicitly attached to the current user turn.
2. Match those files to the already primed CodeAPI references.
3. Invoke the existing CodeAPI bash execution transport once to extract a
   bounded, structured preview under the current code session.
4. Validate the returned manifest and append it to the current agent's
   additional instructions.
5. Start the model only after every selected file has a valid manifest entry.

If the pre-parse fails, the request stops before model invocation and returns a
visible filename-specific error. It must not create a model transaction or a
successful empty assistant message.

This is orchestration around the existing CodeAPI and `/mnt/data` contract. It
does not add another converter service, another upload route, a PPT template,
or a prompt-keyword retry.

## Scope

Change only the repository-owned LibreChat production patch used by
`LibreChat-API`:

- `office-context-patch/api-index.cjs`: current-turn Office selection,
  deterministic CodeAPI pre-parse, manifest validation, and bounded context
  injection.
- `office-context-patch/BaseClient.js`: classify reasoning-only output as an
  incomplete response unless a final text or downloadable artifact exists.
- focused contract tests and deployment scripts under a new dated patch
  directory.

Do not change WebAI, OpenWebUI, Nginx, Mongo data, CodeAPI source, Admin Panel,
the upload menu, or the generated-file callback.

## File Contract

The pre-parse allowlist follows the existing Office upload contract:

```text
.docx .xlsx .xlsm .ppt .pptx .csv .tsv .ods .odp
```

Only `req.body.files` for the current turn are eligible. Historical files can
still be used by an explicit later tool call through LibreChat's existing
thread behavior, but they are not automatically pre-parsed or injected into a
new turn.

The manifest contains, per file:

- exact sandbox filename;
- format and size;
- document/sheet/slide structure;
- bounded text or table previews;
- truncation markers;
- parse status and a safe error when parsing fails.

The aggregate injected preview is capped. Full original files remain available
under `/mnt/data` for later model-directed analysis or modification.

## Failure Rules

- Missing or mismatched CodeAPI reference: stop before model invocation.
- Missing file in `/mnt/data`: stop before model invocation.
- Unsupported or corrupt Office file: stop before model invocation and name the
  failing file.
- CodeAPI timeout or non-success result: stop before model invocation.
- Empty text or reasoning-only completion: treat as an incomplete model
  response; do not persist it as a successful assistant message.
- Title-generation timeout: retain the default title and do not abort the main
  response.

## Verification

Repository checks:

```sh
node --check deployment/production-patches/2026-07-10-office-ppt-deterministic-fallback/office-context-patch/BaseClient.js
node --check deployment/production-patches/2026-07-10-office-ppt-deterministic-fallback/office-context-patch/api-index.cjs
node deployment/production-patches/2026-07-19-office-preparse-gate/scripts/test-office-preparse-gate.js
git diff --check
```

Business acceptance:

1. Four valid DOCX/XLSX files plus a study request cause one successful
   CodeAPI execution before the first model request and return visible text.
2. A corrupt Office file returns a filename-specific error with no model
   transaction and no assistant placeholder.
3. A normal no-file conversation follows the unchanged path.
4. Office-to-PPT/Excel generation continues to save into `/mnt/data`, persists
   real artifacts, and renders download cards.
5. A reasoning-only provider response is rejected as incomplete rather than
   saved as a successful blank reply.

## Release Gate

1. Commit and push this design record before implementation.
2. Implement and run focused tests locally.
3. Commit and push the implementation before any production write.
4. Prepare an exact-revision artifact through repository release governance.
5. Capture production preflight, hashes, timestamped backups, service IDs,
   memory/disk checks, and rollback readiness.
6. Replace only the required `LibreChat-API` patch files and recreate only
   `LibreChat-API`.
7. Complete HTTP smoke tests and a fresh authenticated Office business test.
8. Record acceptance evidence and the exact rollback command.

## Rollback

Restore the timestamp-matched pre-release copies of the replaced API patch
files, recreate only `LibreChat-API`, then verify normal chat, CodeAPI health,
Office upload visibility, generated-file download cards, and the protected
`/office/` boundary.
