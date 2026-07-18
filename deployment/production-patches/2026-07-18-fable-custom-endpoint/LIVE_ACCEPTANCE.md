# Live Acceptance

Date: 2026-07-18
Release commit: `68318486430f3c5cbc481bb7648caed19ca8f92a`

## Passed

- base configuration advanced from version 26 to 27 during the route change;
- backup `fable-custom-endpoint-20260718161222` exists in
  `codexConfigBackups`;
- custom endpoint `MuskAPI-Anthropic` is present with `provider: anthropic`;
- endpoint URL is `https://api.muskapis.com` and the API key remains an
  environment reference;
- `claude-fable-5` now resolves through `MuskAPI-Anthropic`;
- native `anthropic` remains in the allowed-provider list for old conversation
  compatibility;
- Admin Panel pricing lists `MuskAPI-Anthropic` and `claude-fable-5`;
- main site, `/api/config`, and Admin pricing are healthy; `/office/` remains
  protected with HTTP 401.

## Preserved

- model name and prompt settings;
- historical conversations and transactions;
- native Anthropic configuration;
- CodeAPI, RAG, Nginx, and Mongo containers.

No Fable price was entered because no approved Fable rates were supplied.
