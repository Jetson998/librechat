# Model Market Table Layout Follow-up

Date: 2026-07-19

## Objective

Stabilize the model-market table column allocation and present the official
input reference beside the model discount badge.

## UI Contract

- model name: 26%;
- context: 10%;
- input price: 19%;
- output, cache-write, and cache-read prices: 15% each;
- the table uses fixed layout so content cannot reallocate columns;
- the model discount badge sits beside the official input reference;
- the discount represents the model offer, using input price as the comparison
  basis.

## Deployment Scope

The release copies the current Context Safety Stage B client distribution,
replaces only `user-usage-dashboard.js` and `user-usage-dashboard.css`, updates
their cache-busting references, and recreates only `LibreChat-API`.

Admin, Nginx, CodeAPI, RAG API, MongoDB, the Office route, the usage API route,
and all other mounted client assets remain unchanged.

## Rollback

Restore the backed-up Compose override and recreate only `LibreChat-API`.

