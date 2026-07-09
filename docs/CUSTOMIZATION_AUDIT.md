# LibreChat Customization Audit

Target deployment:

```text
https://152.32.172.162.sslip.io/
```

Audit date: 2026-07-09

Baseline used for this first pass:

- Publicly visible production HTML and `/api/config`.
- Local SOP notes in this repository.
- Prior operational notes about the same host family.
- Upstream baseline inferred from production `buildInfo.commit`:
  `8fcb77fe6fcc91bd82f290b6db604c4c8bdb01c9`.

This is not yet a full source-level diff. The local repository currently stores
operations documentation, not the modified LibreChat source tree.

## Confirmed Additions Or Differences

### 1. Business upload label patch

The delivered HTML contains a custom script:

```text
business-upload-label-patch
```

It rewrites LibreChat upload menu labels into clearer Chinese business labels:

```text
Upload to Provider -> 原文件上传
Upload as Text -> 提取文字上传
Upload to Code Environment -> 用代码读取文件
```

Effect:

- This is a frontend UX patch.
- It helps operators choose the correct upload path.
- It does not by itself change upload backend behavior.

### 2. Production auth policy

`/api/config` shows:

```text
emailLoginEnabled: true
registrationEnabled: false
passwordResetEnabled: false
socialLoginEnabled: false
```

Effect:

- Public registration is closed.
- Login is email/password based.
- Social login and password reset email are disabled.

This is primarily configuration hardening rather than a LibreChat source-code
feature.

### 3. Public server domain and Nginx exposure

`/api/config` reports:

```text
serverDomain: https://152.32.172.162.sslip.io
```

Root headers show:

```text
server: nginx/1.20.1
x-robots-tag: noindex
```

Effect:

- The app is publicly reachable through the sslip.io domain.
- Search indexing is discouraged by `x-robots-tag: noindex`.

### 4. Runtime asset recovery and diagnostics guard

The delivered HTML also contains a startup script with markers such as:

```text
__lcRumRecoveryGuardInstalled
__lcRecoverStaleAssets
lc-rum-queue
lc-asset-recovery-at
```

Observed behavior:

- Captures asset load and dynamic import failures.
- Stores a small session diagnostic queue.
- Unregisters matching service workers and reloads the page when stale assets
  are detected.
- Responds to service-worker ping messages.

This looks like a runtime reliability patch. It should be confirmed against the
exact upstream source tree before treating it as a final custom-code finding.

### 5. Code environment wording and operational workflow

The upload label patch explicitly exposes the code-environment path as:

```text
用代码读取文件
```

Prior operational notes for this deployment family show that code-environment
availability and attachment routing must be verified with real smoke tests, not
assumed from UI flags alone.

Known operational distinction:

- A normal local attachment can exist without reaching `tool_resources.execute_code`.
- A fresh code execution smoke test is needed to prove the backend path works.

### 6. LibreChat-adjacent helper services

Prior operational notes for the same host family mention helper routes/services
that are adjacent to LibreChat but not necessarily part of LibreChat core:

```text
/office/
/claude/
/claude-login/
```

Known roles:

- `/office/`: Office document conversion fallback.
- `/claude/`: browser-accessible Claude CLI terminal.
- `/claude-login/`: cookie/session login wrapper for the Claude terminal.

These should be documented as host-level additions unless the current server
source confirms they are integrated into the LibreChat app itself.

## What Still Looks Like Upstream

The visible production branding still says:

```text
LibreChat
```

Observed examples:

- HTML title: `LibreChat`
- Manifest name: `LibreChat`
- `/api/config` app title: `LibreChat`

So there is no externally visible full rebrand to `Musk WebAI` yet, at least in
the publicly fetched HTML/config/manifest.

## Open Questions For Source-Level Diff

To finish a real diff against upstream LibreChat, collect one of:

- The server-side modified LibreChat source directory.
- The image/build Dockerfile and runtime patch scripts.
- A patch package or Git remote for the deployed app.

Then compare against upstream commit:

```text
8fcb77fe6fcc91bd82f290b6db604c4c8bdb01c9
```

Recommended next checks:

1. Locate the live deployment source or container build context.
2. Search for:

   ```text
   business-upload-label-patch
   __lcRumRecoveryGuardInstalled
   __lcRecoverStaleAssets
   原文件上传
   用代码读取文件
   ```

3. Separate pure configuration changes from source changes.
4. Confirm whether CodeAPI, Office conversion, and Claude terminal are separate
   services or integrated app features.
