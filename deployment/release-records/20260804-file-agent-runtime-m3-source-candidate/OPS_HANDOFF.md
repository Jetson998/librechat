# M3 File Agent Runtime source candidate: isolated Operations handoff

## What this is

This is a source-only, non-production candidate for the reviewed M3 DOCX Word
capability. It is not an OCI image, Compose override, production runner, or
authorization to deploy to a production LibreChat host.

The authoritative revisions are:

- source candidate: `a2624f8b18597e292fb83e8b2cfb71de1e1e7d9e`;
- clean overlay baseline: `db4e10717d88d27eaf6b11b3903e445588c483e3`.

The release artifact is named:

```text
20260804-file-agent-runtime-m3-source-candidate-a2624f8b1859.tar.gz
```

Read the sidecar `manifest.json` and `SHA256SUMS` before extracting the
artifact. Their paths and final SHA-256 are recorded in `RELEASE.json` after
candidate packaging completes.

## Scope

The archive contains the complete tracked source subtrees:

- `services/file-agent-runtime/`
- `services/librechat-file-agent-connector/`

It also contains the M3 design document and the repository release-governance
files needed to validate the candidate's provenance. It deliberately excludes
`node_modules`, credentials, production configuration, downloaded user files,
and unrelated LibreChat source.

## Isolated validation procedure

1. Stage a clean non-production source checkout at the baseline revision, or
   use an isolated checkout of the candidate source revision. Never extract it
   over a production checkout or a live container filesystem.
2. Verify the baseline when using the overlay form:

   ```sh
   git rev-parse HEAD
   # expected: db4e10717d88d27eaf6b11b3903e445588c483e3
   ```

3. Verify the handoff checksums, inspect the manifest, then extract the source
   archive relative to the isolated checkout root.
4. With Node.js 20 or newer, run in each packaged service:

   ```sh
   npm run check
   npm test
   ```

5. Run the guarded Phase 3D acceptance using only an isolated local MongoDB,
   isolated Runtime, isolated CodeAPI fixture, and recorded model relay. Supply
   the required `FILE_AGENT_PHASE3D_*` confirmation and isolated dependency
   path as described in the Connector README. Do not point any variable at a
   production service, customer file, or credential.

6. Record the result against this exact source revision and artifact SHA-256.
   A passing isolated result should show one verified DOCX output and no
   duplicate delivery or usage receipt on replay.

## Stop conditions

Stop and report instead of adapting the candidate if any of these occur:

- artifact checksum, source revision, or baseline revision does not match;
- the workspace is not isolated or points to a production dependency;
- a production CodeAPI, model relay, MongoDB, customer file, or credential is
  requested;
- a deployment, image build, feature-flag, secret-distribution, or Compose
  change is needed.

Those needs belong to the next, separately reviewed production-integration
batch. M3 has no production startup hook, feature flag, secret source, CodeAPI
protocol mapping, container definition, or deployment runner.
