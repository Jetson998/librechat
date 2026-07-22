# User Balance And Admin Credits Plan

## Goal

Expose the existing LibreChat balance system as a small account-credit product:

- administrators can add or deduct credit for one user;
- users can see their available USD balance and recent credit adjustments;
- model usage continues to use LibreChat's native transactions and balance deduction;
- online payment, checkout, invoices, and user self-service recharge remain out of scope.

## Accounting Contract

LibreChat stores balance as integer `tokenCredits`. With this deployment's model prices expressed
in USD per one million tokens:

```text
1,000,000 tokenCredits = US$1.00
```

The Admin and user interfaces accept and display USD. Conversion to credits happens only at the
API boundary. Amounts are limited to six decimal places so every displayed amount maps exactly to
an integer credit value.

Model spending remains authoritative in native transaction documents:

```text
transaction.tokenValue / 1,000,000 = USD cost
```

## Data Design

Keep `balances.tokenCredits` as the only current-balance field. Administrator adjustments are
stored in a capped `adminAdjustments` array on the same balance document. A single conditional
`findOneAndUpdate` performs both `$inc` and `$push`, so the balance and its audit entry cannot drift.

Each adjustment contains:

- client-generated idempotency ID;
- signed integer credit amount;
- administrator user ID;
- short operator note;
- creation timestamp.

The API keeps the latest 200 adjustments per user. Reusing an adjustment ID returns the existing
result and never applies the amount twice.

## API Surface

Authenticated user:

```text
GET /api/user/usage-dashboard
```

The existing response gains:

```text
account.balanceUsd
account.balanceEnabled
account.adjustments[]
```

Administrator with `MANAGE_USERS`:

```text
GET  /api/admin/users/:id/balance
POST /api/admin/users/:id/balance-adjustments
```

The POST body is:

```json
{
  "adjustmentId": "client generated UUID",
  "amountUsd": 10,
  "note": "Initial service credit"
}
```

Negative amounts are allowed, but an adjustment cannot make the resulting balance negative.

## User Experience

Admin Panel user rows gain an `额度管理` action. The dialog shows the current balance, accepts a
signed USD amount and note, and lists recent administrator adjustments.

The LibreChat `我的 -> 用量统计` panel shows:

- current available balance;
- a quiet `暂不支持在线充值` message;
- recent credit additions and deductions in a dedicated `额度记录` view.

The internal word `credits` is never shown to customers.

## Release Gates

Before production deployment:

1. verify `balance.enabled=true` in the resolved production config;
2. verify model `tokenConfig` prices use the expected USD-per-million convention;
3. back up the target user's balance document before the first live adjustment test;
4. test idempotent replay and insufficient-balance rejection without a billable model request;
5. verify one user cannot read another user's balance or adjustment history;
6. deploy only the API, Client and Admin Panel artifacts selected by release governance.
