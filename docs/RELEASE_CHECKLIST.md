# Release Checklist

Use this for small LibreChat production changes.

## Change Summary

- Date:
- Operator:
- Change name:
- Reason:
- Expected user-visible effect:
- Rollback action:

## Before Change

- [ ] Root URL returns `200`.
- [ ] `/api/config` has been captured.
- [ ] Login works in a browser.
- [ ] Simple chat returns non-empty content.
- [ ] Relevant files/configs are backed up.
- [ ] No production secrets will be committed to this project.

Commands:

```sh
curl -k -I https://152.32.172.162.sslip.io/
curl -k -L https://152.32.172.162.sslip.io/api/config
```

## After Change

- [ ] Root URL returns `200`.
- [ ] Main frontend asset returns `200`.
- [ ] `/api/config` matches intended auth/interface settings.
- [ ] Browser login works.
- [ ] Simple chat returns non-empty content.
- [ ] File upload still works if upload UI or backend changed.
- [ ] Code execution works if code environment changed.
- [ ] Runtime Chinese labels still show if frontend assets changed.
- [ ] Rollback path remains available.

## Notes

Record exact observations, not guesses. If something is inferred, mark it as an
inference and add the command or browser check needed to verify it later.
