# PPT Modal Entry With Cumulative Client

This production patch deploys the independently built cumulative LibreChat
Client and the separate PPT static entry from candidate source revision
`a79bfb08461016044d092f6fd1ec584811047fde`.

## Scope

- replace only the read-only `/app/client/dist` mount used by `LibreChat-API`;
- recreate only Compose service `api` / container `LibreChat-API`;
- atomically switch `/opt/librechat/ppt-entry-plan-a-redirect/current` to the
  new PPT static directory;
- keep the existing PPT Nginx configuration unchanged and do not reload Nginx;
- keep MongoDB, CodeAPI, RAG, Admin, Nginx containers, model configuration,
  files, conversations, and secrets unchanged.

The Client artifact must contain exactly 352 files and preserve all ten
protected overlay assets. The PPT artifact remains independent and must never
be copied over the LibreChat Client directory.

The remote runner captures a fresh read-only production snapshot immediately
before apply. It saves the Compose override and previous PPT symlink target,
then automatically rolls both targets back if any post-apply check fails.

No model request, database write, customer file read, or Nginx configuration
change is required by this release.
