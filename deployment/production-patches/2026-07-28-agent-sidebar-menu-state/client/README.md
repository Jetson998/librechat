# Client Artifact Contract

The deployable Client is the immutable GitHub Actions artifact recorded in
`artifact.json`. The ZIP is deliberately not committed to Git. An operator must
download artifact `8679020809`, pass its local path to the verifier and release
runner, and preserve the exact ZIP SHA-256.

The release does not rebuild Client files on the production host. Production
only verifies the ZIP, safely extracts `client-dist.tar.gz` into a versioned
directory, changes the existing `/app/client/dist:ro` mount, and recreates the
`LibreChat-API` container.
