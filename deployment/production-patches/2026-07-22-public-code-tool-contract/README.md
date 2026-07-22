# Public Code Tool Contract

This release moves code/file tool naming guidance from individual model specs
into the common Agent initialization path.

## Behavior

- Builds one concise runtime contract from the code/file tools actually
  registered for the current run.
- Applies to every provider and model using the Agent execution path, including
  future model specs.
- Clarifies that `execute_code` is a capability marker, while callable tools
  use names such as `bash_tool` and `read_file`.
- Keeps the existing strict `Bash`, `Read`, and `Skill` compatibility mapping.
- Does not normalize `Grep`, `Glob`, `Edit`, `LS`, or unknown tools.
- Removes conflicting code-tool-name sentences from the current GPT and Fable
  Mongo model specs without changing Office, upload, pricing, or file rules.

The deployment replaces only the LibreChat API bundle mounts and advances the
base Mongo config with a rollback backup. CodeAPI is verified unchanged.
