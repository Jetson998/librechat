# LibreChat Search Favicon Fallback Plan

Date: 2026-07-18

Status: design and implementation prepared; production deployment has not
started.

## Problem

The existing web-search result component renders every source icon from:

```text
https://www.google.com/s2/favicons?domain=<domain>&sz=32
```

The current client network cannot reach `www.google.com`. A 15-second curl
probe returned HTTP status `000`, and every rendered favicon in conversation
`a98930ef-5cc2-46ca-b664-f2b5eab24dea` had zero natural width and height.
Search text, source titles, source links, and the Serper result count were all
present, so this is a presentation-only dependency failure.

## Scope

Add a readable repository-owned browser asset that immediately replaces only
Google favicon image URLs with deterministic local SVG data URLs. The fallback
uses the source domain's first letter and a stable color.

The release must not:

- edit LibreChat's compressed `assets/index.P3glMaNP.js` or hooks bundle;
- change Serper, web-search configuration, prompts, conversations, or users;
- add another external favicon provider;
- modify Nginx, CodeAPI, Office, RAG, MongoDB, or Admin Panel;
- create or send a conversation during acceptance.

## Runtime Contract

- target only `img[src^="https://www.google.com/s2/favicons"]`;
- replace the URL before the failed remote image is painted;
- preserve the domain in `alt` and a data attribute;
- set `referrerpolicy=no-referrer`;
- observe newly rendered search results without rescanning unrelated data;
- inline the readable source into the no-store HTML shell to avoid stale asset
  behavior.

## Production Baseline

```text
compose_override_sha=cd6002ddc8893f25a6337dc823c9a9978f928aa5652f7e16ca28ac4d4e8fa6d2
client_mount=/opt/librechat/user-usage-usd-symbol/0b57393fab4b-20260718214145/client-dist
client_index_sha=488e92e83bd289e709ae746e766c28af9c176406a4d93d0a8d6d1c7958fea76e
usage_route=/opt/librechat/user-usage-cutover-cost-detail/57ed9f9-20260718212527/usage-dashboard.js
usage_route_sha=6d51f0f488790bc117a2ae33a61c0a23a296ee1dbc5a7352e84fa7d09d35e187
```

The release will copy the complete current Client, inject one inline marker,
replace only `/app/client/dist:ro`, and recreate only `LibreChat-API`.

## Acceptance

- the existing football-news conversation still shows 13 sources and links;
- no source icon keeps a Google favicon URL;
- source icons have positive natural dimensions;
- each replacement records its domain in
  `data-lc-search-favicon-fallback`;
- no message is sent and no new conversation is created;
- upload menu, usage dashboard, Stage B, Office, and web-search output remain
  available.

## Rollback

Restore the timestamped Compose override backup and recreate only
`LibreChat-API`. No database or file-storage rollback is required.
