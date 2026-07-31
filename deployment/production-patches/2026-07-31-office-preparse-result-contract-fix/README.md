# Office pre-parse result contract fix

Development patch for two coupled failure modes in the Agent Office path:

1. Parse exactly one balanced JSON manifest after the Office marker while keeping
   known Bash wrapper stderr and generated-file summaries outside the manifest.
2. Persist a terminal user/assistant message pair when Agent initialization fails
   before `sendMessage()`, so the preliminary underscore response ID is no longer
   an orphan that permanently blocks the next follow-up with HTTP 409.

Development completed and was frozen in commit `ae2e324`. Release automation is
kept separate under `scripts/`: it packages files from an explicit Git revision,
backs up the current Compose override, replaces only the three API mounts, and
force-recreates only `LibreChat-API`. CodeAPI, NGINX, RAG, Admin, and MongoDB are
checked as unchanged protected services.

Run the focused test:

```sh
node deployment/production-patches/2026-07-31-office-preparse-result-contract-fix/scripts/test-office-preparse-result-contract.js
```

Run the bounded release from an exact committed revision:

```sh
deployment/production-patches/2026-07-31-office-preparse-result-contract-fix/scripts/deploy.sh <full-commit-sha>
```

Automatic rollback restores the timestamped Compose override backup and
recreates only the API if any post-write check fails.

## Production result

Deployed revision `657994b62e45e701cf625870cf6d5f3c835d3887` at
`2026-07-31T11:10:41Z`.

- Release: `/opt/librechat/office-preparse-result-contract-fix/657994b62e45-20260731191021`
- Backup: `/opt/librechat/backups/office-preparse-result-contract-fix-657994b62e45-20260731191021`
- Compose SHA-256: `08a004de934c939bab38093968e92325dbd3ae56de30167b8a5335de1208770c` -> `4c16b418db1c71961c776f5b65c9090a43ea42a47a39f99b2c447a19028820ba`
- API container: `3e82f51eb10120b2a7c3c2aaff4b0305c5174f554ead8a7e9ac9bf7ab457bd17` -> `a13e8afaccf9b4784aa395212bf2ed9f447aa4e43062fef47d743a82b18ba142`
- CodeAPI container remained `31ef4b61d9702cf63fdf7d3a1fdbc6a6c0edaef9c0cb3da0774d4ef5fff618e0`; NGINX, RAG, Admin, and MongoDB were also unchanged.
- Mounted file hashes: `InitializationFailure.js` `547bd84e25b136148cd12582e900c6b41ab85170b909b01bd14a7c37b0e78abd`; `request.js` `74fbe28c30fd0ac34393fc01f2dda5cdcae32bee7798a81157e69f96e6fe8d38`; `OfficePreparse.js` `da3380cc67b89d510ef841ef0687eec7706bb50bc8922169399d46ea57e792c7`.
- Public checks: `/` 200, `/api/config` 200, `/office/` 401.

Focused business acceptance passed with `vip998` and
`受益所有人信息对比和差异报告_ivy.docx` in conversation
`df545641-8ef4-45bf-8a4c-6b9537e4962b`. The Office parser completed, the model
returned a chapter summary and three key conclusions, and CodeAPI recorded three
successful `POST /exec` calls. MongoDB contains a terminal assistant message
parented to the persisted user message with `error=false` and
`unfinished=false`; no invalid-manifest, CodeAPI 500, or HTTP 409 entry appeared
in the release-window logs. The new conversation title is
`文件概括与关键结论`.
