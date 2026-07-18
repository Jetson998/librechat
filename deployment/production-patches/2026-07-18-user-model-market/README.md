# User Model Market Phase One

Date: 2026-07-18

Status: implementation complete and locally verified; production deployment pending.

## Objective

Add a `模型市场` view below `对话日志` in the user's existing usage dialog.
Expose only models explicitly marked for publication by an administrator, with
the current API prices already used by LibreChat billing.

## Pricing Semantics

The market table shows:

- model name;
- context capacity, sourced from the existing model configuration when present;
- current input price;
- current output price;
- current cache-write price;
- current cache-read price;
- input discount versus the official reference price.

Only input discount is calculated:

```text
输入优惠率 = (官方输入价 - 当前输入价) / 官方输入价
```

The percentage is omitted when the model has no official input reference or no
current input price. Output and cache prices are displayed without discount
claims.

## Configuration Contract

Market metadata uses a namespaced `market` object inside the existing literal
model configuration. This reuses the Admin Panel's Mongo-safe model-key writer
without adding another persistence path. LibreChat billing continues to read
only the native price fields:

```json
{
  "gpt-5.6-sol": {
    "prompt": 0.6,
    "completion": 3.6,
    "cacheRead": 0.06,
    "cacheWrite": 0.75,
    "market": {
      "published": true,
      "officialPrompt": 1.25
    }
  }
}
```

The existing native price keys remain the only source for actual billing.
`market` only controls publication and the official input-price reference used
for display; it is ignored by cost calculation.

## Phase One Scope

- Admin Panel model pricing page: publication toggle and official input price;
- authenticated user model-market API;
- `模型市场` tab below `对话日志`;
- compact table matching the existing usage-dialog style;
- no customer contact form, phone/email/WeChat collection, or admin inbox.

## Phase Two Boundary

Add a restrained business-contact callout, selectable contact medium, contact
value, submission endpoint, anti-abuse controls, and an Admin Panel inbox only
as a separate design and release. Do not add these fields to phase one.

## Privacy And Safety

Only published models and their public prices are returned. Internal endpoint
names, credentials, unpublished models, and full configuration are never sent
to the user client.

## Verification

- user API aggregation and publication filtering tests;
- user client static release checks;
- Admin Panel pricing helper tests and TypeScript typecheck;
- Admin Panel production build;
- phase-one boundary check that excludes the business-contact workflow.

## Rollback

Remove the user market asset and route mounts, and restore the prior Admin Panel
image. Native billing and historical transactions remain untouched.
