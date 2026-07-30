# Client Artifact Contract

The deployable Client is the immutable independent-build artifact recorded in
`artifact.json`. It replays the pinned five-layer upstream overlay and changes
only the category comparison fallback introduced after production acceptance
found that `all.count` is absent from the real API response.

The local release ZIP must match SHA-256
`4c962d7b5ec44ffefe8cd339a8efa5d20d87b1d19020f7a6f7e45cd7ca8fdcd9`.
Production never rebuilds Client files: it verifies the ZIP, safely extracts
`client-dist.tar.gz`, changes only `/app/client/dist:ro`, and recreates only
`LibreChat-API`.
