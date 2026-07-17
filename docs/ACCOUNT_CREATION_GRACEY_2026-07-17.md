# Gracey Production Account Creation

Date: 2026-07-17

Status: completed and verified in production.

## Account

- Email: `Gracey@example.local`
- Name: `Gracey`
- Username: `Gracey`
- Role: normal user
- Email verified: yes

The password is supplied out of band and must not be written to the repository,
shell arguments, terminal logs, or verification output.

## Procedure

1. Push this operation record to `origin/main` before changing production.
2. Confirm no user already exists for the email or username.
3. Run LibreChat's supported `/app/config/create-user.js` script in the API
   container and provide the password through non-echoed standard input.
4. Verify the Mongo user record has the expected email, username, role, and
   verified status without printing password data or session tokens.
5. Verify `POST /api/auth/login` returns HTTP 200 without retaining or printing
   access and refresh tokens.
6. Record the result and push the production verification update.

## Rollback

If creation succeeds but verification fails and the account has no user data,
use `/app/config/delete-user.js Gracey@example.local`, then confirm the user no
longer exists. Do not delete an account after it has accumulated user data
without a separate review.

## Production Result

Repository gate commit `21d7b60` was pushed to `origin/main` before the
production write.

Completed at 2026-07-17 15:09 HKT using the supported
`/app/config/create-user.js` script with `--email-verified=true`.

```text
email=gracey@example.local
name=Gracey
username=gracey
role=USER
emailVerified=true
provider=local
POST /api/auth/login=200
API_CONTAINER_UNCHANGED=true
```

The password was transferred through a one-time mode-0600 file under `/tmp`,
read into standard input, and removed before verification. It was not passed as
a command argument, stored in the repository, or written to a production
volume. Two earlier standard-input attempts were stopped before any Mongo user
record existed because the upstream CLI opened multiple interactive prompts.
No service or container was restarted or recreated.
