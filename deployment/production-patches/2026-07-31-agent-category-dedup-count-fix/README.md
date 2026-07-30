# Agent Category De-dup Count Fix Production Release

Date: 2026-07-31

Status: independently built Client candidate; production deployment pending.

## Objective

Hide the sole business category when it contains the same seven records as the
promoted Agent result. The real categories API omits `count` on the synthetic
`all` category, so the Client now prefers `all.count` when present and otherwise
uses `promoted.count` as the comparison total.

## Immutable Inputs

- repository Client source commit: `29a1e5ea9fae489d36b8b4a69a351a232dbbe001`;
- LibreChat upstream commit: `8fcb77fe6fcc91bd82f290b6db604c4c8bdb01c9`;
- runtime/category patch SHA-256: `f3ea605fc928318f8b1b56ad4f3cb480adad8cf733be5b56ee8ad5f1fd819ee9`;
- independently built release ZIP SHA-256: `4c962d7b5ec44ffefe8cd339a8efa5d20d87b1d19020f7a6f7e45cd7ca8fdcd9`;
- Client tar SHA-256: `16f276419989af6bd1c83157a0bdec9aa8f07e812cab07123f12a74041a012c0`;
- composed `index.html` SHA-256: `26c320f4ab9562d8ed1ddb22e7609108645b6cdaec7e424290d0b3b9da06f544`.

The exact upstream overlay replay, 24 focused tests, Client typecheck,
production build, protected asset composition, and immutable artifact checks
passed outside the production host.

## Deployment Scope

- create one versioned Client directory under `/opt/librechat/agent-category-dedup-count-fix/`;
- replace only the `LibreChat-API` bind mount at `/app/client/dist:ro`;
- recreate only Compose service `api` / container `LibreChat-API`;
- do not run the previous Mongo migration again;
- keep Agent documents, ACLs, categories, MongoDB, NGINX, CodeAPI, RAG, Admin,
  Office Converter, Runtime Connector, files, Skills, conversations, and model
  configuration unchanged.

## Acceptance

Authenticated `vip998` browser acceptance must prove:

- `/agents` shows only `精选 Agent` and `全部`;
- each of those two views shows seven cards;
- the audit Agent opens with its stored model and without `missing_model`;
- three conversation starters remain visible;
- preset contact remains hidden and personal Agent contact controls remain;
- no prompt is sent and `billable_model_requests` remains `0`.

## Rollback

Before apply, the runner backs up the exact Compose override, active Client,
runtime preflight, candidate metadata, and deployment result. Rollback restores
the previous Client mount and recreates only `LibreChat-API`.
