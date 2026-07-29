# Client Artifact Contract

The deployable Client is the immutable independently reproduced artifact
recorded in `artifact.json`. The binary ZIP is deliberately not committed to
Git. GitHub Actions run `30436620515` independently passed the full pinned
install, package build, focused Agent tests, Client typecheck, Client production
build, protected asset checks, composition, and packaging workflow for source
commit `b87a1f3da70f2a354d8cbb58f2a87007ec58804b`.

The local release ZIP must match SHA-256
`56264deee0e95de4b093e5ca2c7febc0f2f18bf5dbcb0142e2e8d20cd221ee51`
before the release runner accepts it. Production does not rebuild Client files.
It verifies the ZIP, safely extracts `client-dist.tar.gz` into a versioned
directory, changes only the existing `/app/client/dist:ro` bind mount, and
recreates only `LibreChat-API`.
