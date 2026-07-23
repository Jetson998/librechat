# LibreChat upstream controller Runtime bridge overlay

This directory is a non-production, version-pinned source integration overlay.
It does not contain a deployable production patch and is not referenced by the
current production process.

## Source pin

```text
upstream repository: https://github.com/danny-avila/LibreChat.git
upstream commit: 60eba76375213dafc1874d943e41371201c300ab
source file: api/server/controllers/agents/request.js
source blob: 49d9329f0ce7778cb108cdc70ca18aed4c8ec0eb
```

The overlay refuses verification if either the commit or source blob differs.
This prevents a context-based patch from being treated as compatible with a
different LibreChat controller lifecycle.

## What the patch changes

The patch adds one optional sixth `fileAgentRuntime` argument to
`AgentController` and `ResumableAgentController`. When it is absent, the
existing controller still reaches the single original call:

```text
client.sendMessage(text, messageOptions)
```

When an injected bridge returns `suppressNativeAgent: true`, the controller:

1. uses LibreChat's initialized client to save the authoritative user message
   and conversation through `saveMessageToDatabase()`;
2. preserves uploaded files, quotes, selected Skills, conversation identity,
   preallocated assistant message ID, and resumable stream ID;
3. does not call `client.sendMessage()` and does not start title generation;
4. releases only the controller's MCP/pending-request resources and disposes
   the initialized client;
5. leaves final assistant persistence, final SSE event, and
   `GenerationJobManager.completeJob()` to the Connector reconciler;
6. writes a terminal assistant message with the same preallocated ID if the
   user turn was saved but no durable delivery could be created.

A durable delivery remains authoritative even when immediate reconcile
scheduling fails. The periodic reconciler resumes it; the controller does not
complete the job or fall back to native Agent execution.

## Injection contract

The host composition must construct `FileAgentControllerBridge` with adapters
for the running LibreChat instance:

```js
const bridge = new FileAgentControllerBridge({
  connector,
  prepareRequest: (context) => resolveAuthorizedRuntimeRequest(context),
  persistUserTurn: ({ persistUserTurn }) => persistUserTurn(),
  createBillingSnapshot: (context) => createNativeBillingSnapshot(context),
  scheduleReconcile: ({ submission }) => enqueueDelivery(submission.delivery.deliveryId),
});
```

`prepareRequest()` must return only ownership-verified current-conversation
files with primed CodeAPI references. `createBillingSnapshot()` must use the
resolved model pricing for that request and return `snapshotId`. No endpoint
credential may enter the snapshot or task manifest.

The route layer may pass the bridge as the sixth controller argument only for a
non-production allowlisted test process. Route registration, collection names,
Runtime process supervision, and feature-flag configuration are deliberately
not included in this overlay.

## Verify

```sh
scripts/verify-file-agent-upstream-overlay.sh /path/to/clean/librechat-upstream
```

The verifier checks the source pin and blob, applies the overlay in a detached
temporary worktree, runs `git diff --check` and `node --check`, confirms there
is still exactly one native `client.sendMessage()` call, and confirms that only
the pinned controller file changes.
