# CodeAPI process reaper

CodeAPI was still an orphaned Compose service and ran Uvicorn directly as PID 1.
LibreOffice/GnuPG descendants accumulated as zombies until the container's
`pids_limit: 256` was exhausted, causing `/exec` to fail with `EAGAIN`.

This enhanced patch adds CodeAPI back to the active Compose override with
`init: true`, preserves the exact image, mount, limits, security controls and
network identity, and recreates only CodeAPI. The runner verifies all other
protected container IDs remain unchanged and automatically restores the old
override/runtime if any post-write check fails. It never uses
`--remove-orphans`.
