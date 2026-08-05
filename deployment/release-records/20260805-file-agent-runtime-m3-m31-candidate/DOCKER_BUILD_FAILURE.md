# Failed candidate Docker build

This evidence belongs to source revision `fa47c81107f00c189f82d0021714acf391546387`.
It records the first real candidate build and is intentionally kept separate from
the later Dockerfile-only repair.

## Source and artifact

- source revision: `fa47c81107f00c189f82d0021714acf391546387`
- source package: `.release-state/20260805-file-agent-runtime-m3-m31-candidate/artifacts/20260805-file-agent-runtime-m3-m31-candidate-fa47c81107f0.tar.gz`
- source package SHA-256: `cf88683f4f985136090da17bc354dbcc0b786f76c443cc7b8365680772bacc59`
- release plan SHA-256: `3fcad7763eb7ab929a704449734ae2af1e67814e6b133248baa4d1109dd75f36`
- build context: clean `git archive` of the source revision
- image tag: `file-agent-runtime:fa47c811`
- image created: `false`
- production write: `false`

## Command

```text
docker buildx build --platform linux/amd64 --load \
  -f services/file-agent-runtime/Dockerfile \
  -t file-agent-runtime:fa47c811 .
```

Builder: Docker Buildx `orbstack` using the digest-pinned base image:

```text
public.ecr.aws/docker/library/node:20-bookworm-slim@sha256:2cf067cfed83d5ea958367df9f966191a942351a2df77d6f0193e162b5febfc0
```

## First failing stage

The build reached the Dockerfile APT layer and failed during the first
`apt-get update`. The base image had no usable CA bundle, while the Dockerfile
had already replaced the sources with HTTPS Debian snapshot URLs. The locked
`ca-certificates` package therefore could not be installed because its index
could not be fetched first.

## Captured failure output

```text
Certificate verification failed: The certificate is NOT trusted.
Could not handshake: Error: [IP: 199.232.114.132 443]
W: No system certificates available. Try installing ca-certificates.
W: Failed to fetch the Debian snapshot InRelease files.
E: Version '20230311+deb12u1' for 'ca-certificates' was not found
E: Unable to locate package libreoffice-calc
E: Unable to locate package libreoffice-impress
E: Unable to locate package libreoffice-writer
E: Unable to locate package python3
E: Unable to locate package python3-venv
ERROR: failed to solve: process apt-get update and locked package install did not complete successfully
```

The exact source lines are retained in the failed source package and were
reviewed at [Dockerfile](../../../services/file-agent-runtime/Dockerfile).
The resulting image was checked with `docker image inspect` and was absent.

## Boundary

This failure invalidates only this candidate build. It does not change the
Office business implementation and it did not touch a production target. The
next revision may modify only the Dockerfile CA/APT bootstrap order before the
narrow Sol review.
