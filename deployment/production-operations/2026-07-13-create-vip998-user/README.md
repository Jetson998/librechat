# Create vip998 LibreChat User

Date: 2026-07-13

Status: planned; production write not yet executed.

## Reason

Create one locally managed LibreChat login account while public registration
remains disabled.

## Intended Change

- Email: `vip998@example.local`
- Name: `vip998`
- Username: `vip998`
- Email verification: enabled
- Initial role: normal LibreChat user

The password was supplied by the operator and must be entered through
non-echoed standard input. It is intentionally absent from this repository,
shell commands, logs, and deployment files.

## Affected State

- Add one account through LibreChat's supported `npm run create-user` command.
- Write one new user record and the normal authentication data created by
  LibreChat.
- Do not change application files, Compose files, environment variables,
  Admin Panel configuration, existing users, or running containers.

## Production Command

Run from the production host:

```sh
cd /opt/librechat
docker compose exec api npm run create-user -- \
  vip998@example.local vip998 vip998
```

Enter the password interactively and accept the default verified-email setting.
An automated operator may use `docker compose exec -T` and non-echoed standard
input, provided the password is never placed in the command line.

## Verification

1. Confirm the CLI reports `User created successfully!` and email verification
   is true.
2. Submit the supplied credentials to `POST /api/auth/login` and require HTTP
   `200`, while discarding the response body so tokens are not logged.
3. Confirm `https://152.32.172.162.sslip.io/api/config` still reports
   `registrationEnabled: false` and `emailLoginEnabled: true`.
4. Confirm no service restart or production file change occurred.

## Rollback

Only if creation or immediate verification fails, and before the account has
any user data, run:

```sh
cd /opt/librechat
docker compose exec api npm run delete-user -- vip998@example.local
```

Confirm deletion of the account and its associated data. Do not use this
rollback after the user has begun normal work without a separate reviewed data
retention decision.

## Expected User-Visible Result

The user can sign in at `https://152.32.172.162.sslip.io/login` with the new
email and supplied password. No public sign-up option is enabled.
