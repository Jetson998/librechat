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
compose_override_sha=0414a99197a5594ef18b06393f615331327b5fc53f15897f2763a4ece52ca68c
client_mount=/opt/librechat/user-usage-cost-detail-availability/de2beeace561-20260718223055/client-dist
client_index_sha=b6834a3533fef6ca1a65d5061ebe63f274c15516bd9a92d14a6ec6b2a84aac87
usage_route=/opt/librechat/user-usage-cost-detail-availability/de2beeace561-20260718223055/usage-dashboard.js
usage_route_sha=5bd0bd087aab75799fb429b7da8cbb68b6947856b6fe388aeb86985a94821ba9
```

The first preflight correctly stopped before a production write when the
parallel usage-cost-detail release changed the Client and Compose baseline.
The release was then rebased to the audited `de2beea` production mount shown
above after a second guarded stop caught the final pricing-data follow-up.

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
