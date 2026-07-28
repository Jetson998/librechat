# Agent Sidebar Menu State Fix Plan

Date: 2026-07-28

Status: implementation validated locally; production unchanged

## Problem

On the deployed `/agents` workspace, the unified sidebar still marks
`对话历史` as pressed while the Agent entry has no active background. Clicking
the Agent entry once or twice keeps `aria-pressed=false`, leaves the sidebar
expanded, and repeats navigation to the same route.

The live reproduction confirmed:

- URL remained `https://152.32.172.162.sslip.io/agents`;
- `对话历史` remained the active panel;
- the Agent entry remained unpressed after two clicks;
- the close-sidebar control remained `aria-expanded=true`.

## Root Cause

The workspace entry is a route command with an `onClick` handler. The shared
sidebar button returned immediately after calling that handler, so it skipped
the normal active, expand, and second-click collapse state machine.

## Decision

Keep route selection separate from side-panel content selection:

- Agent routes explicitly mark the workspace icon active;
- route-controlled commands do not replace the persisted side-panel content;
- an inactive route command navigates without clearing the current panel;
- an active command collapses the sidebar without navigating again;
- direct `/agents`, query-string views, and `/agents/:category` share the same
  selected state;
- stale route state is ignored after leaving the Agent route.

This avoids the blank side panel that would result from persisting a route-only
command as the active content panel.

## Source Scope

The follow-up overlay changes only twelve Client source/test files:

```text
client/src/common/types.ts
client/src/Providers/ActivePanelContext.tsx
client/src/Providers/__tests__/ActivePanelContext.spec.tsx
client/src/components/SidePanel/Nav.tsx
client/src/components/SidePanel/Nav.spec.tsx
client/src/components/UnifiedSidebar/ExpandedPanel.tsx
client/src/components/UnifiedSidebar/__tests__/ExpandedPanel.spec.tsx
client/src/hooks/Nav/useUnifiedSidebarLinks.ts
client/src/hooks/Nav/useUnifiedSidebarLinks.spec.tsx
client/src/locales/agentWorkspaceLocales.spec.ts
client/src/locales/en/translation.json
client/src/locales/zh-Hans/translation.json
```

It does not modify Agent APIs, MongoDB, Runtime, CodeAPI, Office, files, Skills,
permissions, billing, conversations, or the seven planned workflow templates.

## Validation Gate

- Prettier check for all twelve files;
- locale product-name assertion for English and Simplified Chinese;
- 15 focused Agent/Sidebar suites, 137 tests;
- Client TypeScript typecheck;
- production Client build;
- fixed-upstream base overlay and follow-up blob verification;
- protected Client overlay composition in CI;
- desktop and mobile browser acceptance before production deployment.

Production must consume an immutable CI artifact through a new protected
release. Direct production patching is not allowed.
