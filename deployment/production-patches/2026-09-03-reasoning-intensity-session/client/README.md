# Client Artifact Contract

`artifact.json` records the exact independently built Client ZIP and its
source relationship. The production runner verifies the ZIP before transport
and extracts only regular files from its `client-dist.tar.gz` member.

Production changes only the existing read-only `/app/client/dist` bind mount
and recreates only `LibreChat-API`. The previous mount and Compose override
are saved in a timestamped backup before apply.
