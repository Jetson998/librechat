# Agent Guidance and Terminology Production Release

Date: 2026-07-30

Status: independently reproduced Client candidate; production deployment pending.

## Objective

Give the seven preset Agents a visible “可以这样开始” section with three
starter prompts, prefer configured starters for ordinary or personal Agents,
and use Agent consistently in the Agent workspace: “精选 Agent”, category
“Agent”, and Agent-specific descriptions. The backend category value
`automation-workflow` is unchanged, and the separate Assistant tools product
path keeps its Assistant wording.

## Immutable Inputs

- repository Client source commit:
  `157446d1598dff98ee95dedd063a962df262e475`;
- LibreChat upstream commit:
  `8fcb77fe6fcc91bd82f290b6db604c4c8bdb01c9`;
- Agent guidance terminology patch SHA-256:
  `8038176a51b2e98b4730ee639a43cabcfade18c45396b6c4ebeb961cc7736dfe`;
- successful CI run: `30490577877`;
- CI artifact ID: `8739589134`;
- independently reproduced release ZIP SHA-256:
  `c54fb70a60311f9fc4f4f7204ebf45b79eeffae4e8c77dcc63ce6c19ea3553d7`;
- Client tar SHA-256:
  `1a912d51eefb418159d6e37fe0f83b808aae7f22d51b42199e50a3383199da86`;
- composed `index.html` SHA-256:
  `e0a7b257027e0d68f59d4f2b4d033dab525395dc54241a85261169fa4fd1938f`.

The pinned four-layer overlay replay, 18 focused test files (180/180), Client
typecheck, production build, protected asset contracts, and protected Client
composition passed outside the production host. The binary Client ZIP is not
committed to Git; `scripts/verify-artifact.py` validates every member before
SSH transport.

## Deployment Scope

- create one versioned Client directory under `/opt/librechat/agent-guidance-terminology/`;
- replace only the `LibreChat-API` bind mount at `/app/client/dist:ro`;
- recreate only Compose service `api` / container `LibreChat-API`;
- keep NGINX, CodeAPI, RAG, MongoDB, Admin, Office Converter, Runtime
  Connector, data, ACLs, categories, files, Skills, conversations, models, and
  all Agent documents unchanged.

## Acceptance

No billable model request is required. Authenticated `vip998` browser
acceptance must prove:

- `/agents` uses “精选 Agent” and Agent category wording;
- each preset Agent card and detail uses Agent terminology;
- starting a preset Agent conversation shows “可以这样开始” and three prompts;
- ordinary/personal Agent configured contact remains visible and preset contact
  rows remain hidden;
- desktop layout has no overlap or horizontal overflow;
- public root, `/api/config`, Admin Panel, Office Converter `401` boundary, and
  protected Client assets remain healthy.

## Rollback

Before apply, the versioned runner creates a timestamped backup containing the
exact pre-release Compose override, active Client distribution, runtime
preflight, candidate metadata, and deployment result. Rollback restores that
override and Client mount, recreating only `LibreChat-API`.
