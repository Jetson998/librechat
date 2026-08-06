# File Agent Runtime production integration keep/drop/defer

This document freezes the deliberately narrow production-integration scope for
the M3 + M3.1 Office batch. It is an integration boundary document, not a
provider-platform roadmap.

## Keep in the current production scope

- `word-edit-v1`, `xlsx-edit-v1`, `pptx-edit-v1`, and `office-compose-v1`.
- The reviewed LibreChat API overlay and app-local File Agent bridge.
- The real LibreChat CodeAPI `POST /exec` transport with `{lang, code,
  session_id, files}`.
- One fixed server-owned route contract:
  `custom:Muskapis-openai`, protocol `openai-compatible`, and models
  `gpt-5.6-sol` and `claude-fable-5`.
- The selected endpoint/model, `providerRouteRef`, and the public
  `routeConfigDigest` frozen in the task manifest, idempotency identity,
  delivery, active task, provider journal, Runtime usage, and billing record.
- Server-side route secrets, allowlist checks, input ownership, CodeAPI
  session/resource identity, task-workspace artifact isolation, and
  fail-closed startup and request boundaries.
- The existing API + Runtime rollback contract.

The route digest covers only the non-secret routing contract shared by the API
and Runtime registries: LibreChat endpoint, provider route reference, provider
endpoint identifier, protocol, and sorted model allowlist. It never contains a
URL credential, API key, or secret value. Runtime still keeps the actual base
URL and key in its server-owned registry.

## Drop from the current production scope

- Anthropic Messages production routing.
- Arbitrary multiple provider routes.
- Client-supplied or arbitrary external URLs.
- A generic provider-secret management framework.
- A generic SSRF engine.
- New Office Worker capabilities.
- PDF/OCR, dynamic scripts, arbitrary Shell, and image generation.

## Defer

- Anthropic route support.
- A multi-provider registry and route-rotation UI.
- Secret rotation and lifecycle automation.
- The production E2E runner and integration Compose environment owned by
  operations/platform.
- Customer-data migration or historical backfill.

The code revision is complete only when the production-similar environment can
exercise the API bridge, both allowlisted model names, the real CodeAPI
transport, artifact delivery, and the required negative paths. This document
does not authorize candidate packaging, registry publication, preflight,
deployment, restart, or customer-file acceptance.
