# Candidate Artifact Contract

`artifact.json` pins the external cumulative candidate archive, both built
outputs, the production Client baseline, and the ten protected overlay hashes.

`verify-artifact.py` rejects unsafe archive members, duplicate paths, missing
MANIFEST entries, hash drift, unexpected file counts, source revision drift,
and changes to the protected overlay assets.

The candidate archive is intentionally not committed to Git. Its SHA-256 is
fixed by metadata and it is copied into the local release state before the
production write.
