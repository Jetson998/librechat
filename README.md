# LibreChat Self-host

This project stores the operating documentation for the self-hosted LibreChat
deployment currently exposed at:

```text
https://152.32.172.162.sslip.io/
```

The production endpoint was checked on 2026-07-09. It returns the LibreChat
single-page application through Nginx, with public registration disabled and
email/password login enabled.

## Documentation

- [Standard operating procedure](docs/STANDARD_OPERATING_PROCEDURE.md): daily
  checks, release workflow, rollback, model/provider changes, file-upload
  handling, and incident response.
- [Release checklist](docs/RELEASE_CHECKLIST.md): short pre-change and
  post-change checklist for small production updates.
- [Production verification log](docs/PRODUCTION_VERIFICATION.md): current
  externally verified facts about the live site.

## Quick Health Checks

```sh
curl -k -I https://152.32.172.162.sslip.io/
curl -k -L https://152.32.172.162.sslip.io/api/config
```

Expected high-level result:

- `/` returns `HTTP/2 200`.
- `/api/config` returns `appTitle: "LibreChat"`.
- `registrationEnabled` is `false`.
- `emailLoginEnabled` is `true`.

## Operating Principle

Keep the upstream LibreChat application as the stable baseline. Custom behavior,
branding text, runtime patches, and provider configuration should remain easy to
identify, verify, and roll back.

Do not commit production secrets, API keys, database credentials, user exports,
or private log payloads into this project.
