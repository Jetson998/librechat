# GPT-5.6 SOL Default Model Plan

Date: 2026-07-11

Status: design commit `e10b0ad` and implementation commit `f6e553c` are pushed
to `origin/main`. Production remains unchanged until the deployment-runner
commit is also pushed.

## Objective

- Make `gpt-5.6-sol` the default model for new conversations.
- Send the relay's accepted maximum reasoning setting:
  `reasoning_effort: max`.
- Keep `claude-fable-5` available as a non-default manual selection.
- Preserve Skills, CodeAPI execution, `/mnt/data` Office workflows, generated
  file cards, and the current upload-format restrictions for both models.
- Make the change through supported LibreChat configuration only. Do not edit
  LibreChat application source, frontend bundles, or Office pipeline patches.

## Read-Only Findings

- The configured relay is `https://api.muskapis.com` and the existing
  Anthropic endpoint remains healthy.
- The relay model inventory contains `gpt-5.6-sol`. A direct
  `/v1/chat/completions` probe returned `200` with model `gpt-5.6-sol` and
  accepted `reasoning_effort: max`.
- The previously considered name `gpt-5.5-sol` is not available and returned
  `model_not_found`.
- LibreChat's built-in OpenAI `reasoning_effort` schema currently exposes up
  to `xhigh`; `max` is not a valid built-in OpenAI preset value.
- LibreChat custom OpenAI-compatible endpoints support arbitrary `addParams`,
  so `reasoning_effort: max` can be sent without patching source code.
- This LibreChat version includes an Admin Config API capable of overriding
  `modelSpecs`, but the production deployment does not expose a usable Admin
  Panel: `ADMIN_PANEL_URL` is still `http://admin.localhost` and there is no
  deployed admin-panel service or public route. The repository-tracked YAML
  remains the durable configuration source for this release.

## Configuration Design

Update the committed production `librechat.yaml` snapshot only:

1. Add one custom OpenAI-compatible endpoint with:
   - a stable endpoint name;
   - `apiKey: ${ANTHROPIC_API_KEY}` so the existing server-side relay key is
     reused without entering the repository;
   - `baseURL: https://api.muskapis.com/v1`;
   - only `gpt-5.6-sol` in its model allowlist;
   - `addParams.reasoning_effort: max`;
   - the same title model so title generation never falls back to an
     unavailable public OpenAI default.
2. Add the custom provider to `endpoints.agents.allowedProviders` while keeping
   `anthropic` allowed.
3. Add a `gpt-5.6-sol` model spec with `default: true`, `skills: true`, and
   `executeCode: true`.
4. Retain `claude-fable-5` with its existing Anthropic settings but set
   `default: false`.
5. Apply the same generic CodeAPI and `/mnt/data` file rules to both model
   specs. Do not add model-specific Office routing or prompt retries.

No API key, token, cookie, user data, or conversation content will be added to
the repository.

## Repository Implementation

Implementation commit `f6e553c` adds the custom `MuskAPI` endpoint, makes
`gpt-5.6-sol` the sole default model spec, retains Fable 5 as non-default, and
adds a strict YAML/config contract test.

The atomic production runner is:

```text
deployment/production-patches/2026-07-10-office-ppt-deterministic-fallback/scripts/deploy-gpt56-sol-default.sh
```

It validates the candidate inside the current LibreChat container, verifies a
real `gpt-5.6-sol` maximum-reasoning function call, creates a timestamped YAML
backup, replaces only `/opt/librechat/librechat.yaml`, restarts only
`LibreChat-API`, and automatically restores the backup if any required check
fails.

## Verification

Repository checks:

1. Parse the YAML with the LibreChat configuration schema or an equivalent
   strict YAML parser.
2. Assert there are exactly two intended model specs and exactly one default.
3. Assert the GPT endpoint uses `gpt-5.6-sol` and sends
   `reasoning_effort: max` through `addParams`.
4. Assert Fable 5 remains selectable and retains its existing `effort: max`.
5. Run `git diff --check` and a staged secret scan.

Production checks after the deployment-runner commit is pushed:

1. Back up `/opt/librechat/librechat.yaml` with a timestamp.
2. Install the committed candidate atomically and validate it inside
   `LibreChat-API` before restart.
3. Restart only `LibreChat-API`; automatically restore the backup on failure.
4. Verify root `200`, `/api/config` `200`, `/office/` `401`, and CodeAPI health.
5. In an authenticated browser, confirm a new chat defaults to GPT-5.6 SOL and
   Fable 5 remains selectable.
6. Verify a short GPT response, a longer response, a CodeAPI tool call, and one
   representative Office upload/generated-file download flow.
7. Confirm the saved GPT conversation records model `gpt-5.6-sol` and the API
   logs contain no invalid-parameter or model-not-found error.

## Rollback

Restore the timestamp-matched `/opt/librechat/librechat.yaml` backup, restart
`LibreChat-API`, and repeat the HTTP, simple-chat, Fable 5, CodeAPI, and Office
checks. No MongoDB rewrite, frontend rollback, or file-pipeline change is part
of this release.
