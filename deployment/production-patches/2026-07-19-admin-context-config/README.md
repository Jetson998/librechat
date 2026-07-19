# Admin Model Context Configuration Release

Date: 2026-07-19

Status: deployed and production-verified.

## Objective

Deploy the current Admin Panel source with:

- recursive model-pricing persistence verification;
- model-market wording aligned to model-level discount semantics;
- a native `context` field on the model pricing page;
- validation that context is a positive integer;
- a save preview showing the exact `tokenConfig.<model>.context` value.

Context is model capability metadata. It does not participate in billing.

## CI Attestation

```text
source_tree_sha256=7c7249a76b3748aeb763afff7ba3b8ba7853e19897c1d1307eec4abeb0ecfce5
ci_verified_commit=2b182b8b96befa8e1b16e83c48c0952ccc536c68
ci_verified_tag=admin-ci-7c7249a76b37
ci_run_reference=private repository API unavailable to anonymous operator
image_ref=ghcr.io/jetson998/librechat-admin-panel-zh-cn:7c7249a76b37
image_digest=sha256:3a40706d06fe8a70e222a447a85855d69b5b97314dfed98fbecb73c85a3cea00
```

The immutable Git tag points to the verified commit, and the public GHCR image
is available anonymously at the recorded digest.

## Production Scope

The deployment changes only the `admin-panel` image in the existing Compose
override and recreates only `LibreChat-Admin-Panel`.

API, Nginx, CodeAPI, RAG API, MongoDB, the active client mount, the usage route,
Office, model prices, and conversations remain unchanged.

## Follow-up Runtime Configuration

Save `1,000,000` as the context limit for:

- `MuskAPI / gpt-5.6-sol`;
- `MuskAPI-Anthropic / claude-fable-5`.

The preferred ongoing path is the Admin UI. The initial values may be seeded by
the repository-owned `set-context-values.sh` operation when the deployment
invalidates the existing Admin browser session. That operation backs up the
complete active base override, modifies only the two `context` fields, verifies
all other model configuration values are byte-equivalent under EJSON, and does
not restart a service.

## Production Result

See `DEPLOY_RESULT.md`. The Admin image deployment recreated only
`LibreChat-Admin-Panel`. The initial context-value operation restarted no
service and preserved every protected container identity.
