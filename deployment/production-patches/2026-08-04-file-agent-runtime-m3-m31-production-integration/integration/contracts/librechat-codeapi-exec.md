# LibreChat CodeAPI integration contract

This document describes the boundary exercised by the non-production
integration harness. It is a contract for the real LibreChat CodeAPI image;
the repository does not contain the CodeAPI implementation and must not
replace it with a stub when reporting an integration result.

## Inputs and ownership

The CodeAPI image is an operator-supplied OCI input. The harness requires the
image identity recorded in `.env.integration` to match the captured baseline:

```text
image: local/librechat-codeapi:office
image id: sha256:dc97d2378247102a6ef9f42dbabc9698ed5e39d299179db5b356f7a2e7681b3c
platform: linux/amd64
```

The declared image ID is the canonical local tag/index identity. Docker may
report a different platform-selected config ID when inspecting the
`linux/amd64` child of that OCI index; the harness records both identities and
requires the canonical ID to match the declared value.

On a clean machine, `CODEAPI_IMAGE_ARCHIVE` may point to an operator-supplied
Docker/OCI archive. The archive is not committed. If neither the image nor the
archive is available, `import-codeapi-image.sh` stops; a Fake CodeAPI result is
not accepted as proof of this contract.

Files uploaded by the API are owned by the test user and scoped to a test
conversation. The Runtime receives only bounded CodeAPI file references and a
task session identity. The integration state directory is separate from the
repository, and the clean command removes it together with the Mongo volume.

## Upload

LibreChat's CodeAPI file upload is an external API concern. The API bridge and
the Runtime must agree on the resulting file identity:

```http
POST /upload
Content-Type: multipart/form-data
```

The exact multipart field names are owned by the supplied CodeAPI image and
are observed through the real API/CodeAPI path. The integration E2E does not
pretend that a local file path such as `/api/files/...` is a readable host
path.

## Execution

The Runtime invokes the real CodeAPI with:

```http
POST /exec
Content-Type: application/json
```

The request body is required to have this shape:

```json
{
  "lang": "bash",
  "code": "<bounded worker script>",
  "session_id": "<primed storage session>",
  "files": [
    {
      "id": "<codeapi file id>",
      "source_file_id": "<source id>",
      "resource_id": "<test user id>",
      "storage_session_id": "<session id>",
      "name": "<safe filename>",
      "kind": "user"
    }
  ]
}
```

The required top-level fields are:

```text
lang, code, session_id, files
```

The following legacy fields are forbidden on the wire:

```text
item_id, command, injected_files, artifact_paths, timeout_ms
```

The Runtime's `fetch-audit.cjs` records only field names, bounded identity
metadata, code hash and response status. It never records the complete script,
file content, API key or service secret.

## Response

The real CodeAPI response consumed by the Runtime is an object containing at
least:

```json
{
  "exitCode": 0,
  "stdout": "...",
  "stderr": "",
  "files": [
    {
      "id": "<artifact file id>",
      "name": "<artifact name>",
      "storage_session_id": "<session id>"
    }
  ]
}
```

The Runtime maps the returned file to the authorized artifact path and the
Connector performs the final LibreChat ownership and delivery checks. A
successful HTTP response without an artifact or with a mismatched resource
identity is a protocol failure, not a successful Office task.

## Evidence boundary

An integration pass proves that this API/Runtime/CodeAPI/relay/file-isolation
chain worked in the declared non-production environment. It does not prove a
production preflight, production deployment, customer acceptance, or real
model billing. The test relay is local and deterministic; it records the
selected endpoint/model/protocol but never calls a public model endpoint.
