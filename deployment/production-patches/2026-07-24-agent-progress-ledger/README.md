# Agent Progress Ledger

This release adds a small run-scoped progress ledger to the common LibreChat
Agent tool execution path. It also records the product decision that this
LibreChat deployment does not provide image generation.

## Incident

Conversation `435c96b0-4b32-4219-ac92-38755bda4cca` repeatedly scanned the
same CodeAPI directory while waiting for an image that had never been
generated. The run reached LangGraph's recursion limit instead of detecting
the repeated observable state.

## Runtime behavior

`api-patch/tool-progress-ledger.cjs` is dependency-free and keeps only bounded
in-memory state per `run_id`:

- current artifact epoch and hash;
- at most 64 observation hashes;
- first/last step and repeat count for each observation;
- `normal`, `warned`, or `stop_requested` state;
- 30-minute TTL and a 1000-run LRU ceiling.

It does not persist tool arguments, stdout, file contents, prompts, or model
reasoning. It does not query MongoDB, scan the code sandbox, or call another
model.

The common `ON_TOOL_EXECUTE` handler applies this sequence to serial tool
calls:

1. first observation: continue;
2. repeated observation without artifact change: append
   `NO_PROGRESS_WARNING` and permit one strategy change;
3. another previously observed state without artifact change: return
   `NO_PROGRESS_STOP`;
4. another tool batch after the stop request: throw the user-safe
   `AgentNoProgressError` before executing tools.

Parallel batches are recorded but do not trigger state transitions in this
first release, preserving the existing immediate per-call result behavior.

Structured diagnostics are emitted only for warning, stop, and abort events.
They contain run/thread/agent IDs, tool name, step, hashes, artifact epoch, and
repeat counts, without raw user or tool content.

## Image generation boundary

`scripts/mongo-config.js` appends one versioned prompt contract to the existing
`gpt-5.6-sol` and `claude-fable-5` model specs:

- image generation is unavailable in this product;
- the model must not claim an image was generated without a real artifact;
- the model must not search the sandbox for an image that was never produced;
- uploaded existing images remain available for PPT and document editing.

The contract is idempotent and the full active base Mongo configuration is
backed up before application.

## Preserved behavior

- The existing `Bash`/`Read`/`Skill` compatibility normalizer remains mounted.
- The deployed public code-tool contract remains active; the release packages
  and verifies `code-tool-contract.cjs` instead of relying on an older mount.
- Office upload, pre-parse, CodeAPI file injection, artifact persistence, and
  download cards are unchanged.
- `recursionLimit=50` remains the final global safety limit.
- CodeAPI, MongoDB, Office Converter, RAG, Admin Panel, and historical messages
  are not recreated or migrated.

## Validate

```sh
node deployment/production-patches/2026-07-24-agent-progress-ledger/scripts/test-progress-ledger.js
node --check deployment/production-patches/2026-07-24-agent-progress-ledger/api-patch/api-index.cjs
node --check deployment/production-patches/2026-07-24-agent-progress-ledger/api-patch/code-tool-contract.cjs
node --check deployment/production-patches/2026-07-24-agent-progress-ledger/api-patch/tool-call-normalizer.cjs
node --check deployment/production-patches/2026-07-24-agent-progress-ledger/api-patch/tool-progress-ledger.cjs
node --check deployment/production-patches/2026-07-24-agent-progress-ledger/scripts/mongo-config.js
bash -n deployment/production-patches/2026-07-24-agent-progress-ledger/scripts/deploy.sh
bash -n deployment/production-patches/2026-07-24-agent-progress-ledger/scripts/remote-apply.sh
git diff --check
```

## Production boundary

The governed deployment refuses to run unless the current production API
package hash equals `BASELINE_SHA256`. It mounts the candidate API package, the
public code-tool contract, the existing alias normalizer, and the new progress
ledger, applies the versioned Mongo prompt contract, and recreates only
`LibreChat-API`.

Rollback restores the exact Compose override and complete Mongo base document,
then recreates only the API service.
