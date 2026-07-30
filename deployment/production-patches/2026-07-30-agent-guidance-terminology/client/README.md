# Client Artifact Contract

The deployable Client is the immutable independently reproduced artifact
recorded in `artifact.json`. GitHub Actions run `30490577877` passed the pinned
four-layer install, package build, focused Agent tests, Client typecheck,
production build, protected asset checks, composition, and packaging workflow
for source commit `157446d1598dff98ee95dedd063a962df262e475`.

The local release ZIP must match SHA-256
`c54fb70a60311f9fc4f4f7204ebf45b79eeffae4e8c77dcc63ce6c19ea3553d7` before the
release runner accepts it. Production does not rebuild Client files. It verifies
the ZIP, safely extracts `client-dist.tar.gz` into a versioned directory,
changes only the existing `/app/client/dist:ro` bind mount, and recreates only
`LibreChat-API`.
