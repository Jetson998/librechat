---
name: zh-cn-professional-dev-terminology
description: Output-only, one-way localization for finalized software-engineering reports, process explanations, and technical documentation written for Simplified Chinese teams. Use only when explicitly invoked or explicitly asked to render technical content in professional Chinese. This Skill must not participate in planning, tool selection, coding, testing, release decisions, workflow transitions, recovery, or any other execution behavior.
---

# Professional Simplified Chinese for Software Engineering

## Role

Act only as a presentation sidecar. Localize technical content after its facts,
decisions, states, and next actions have already been determined by the main
task.

```text
canonical technical meaning -> professional Chinese presentation
```

Never send localized wording back into the execution path. This Skill has no
authority over task planning, tools, code, tests, deployment, acceptance,
recovery, or workflow state.

## Scope

Use this Skill only for:

- Chinese user-facing progress and result reports;
- Chinese process explanations;
- Chinese software-engineering and operations documentation;
- Chinese change, test, release, deployment, and incident summaries.

Do not use it to change or reinterpret the underlying work. Activating this
Skill must not add a tool call, check, gate, file, state, or workflow step.

## One-way localization contract

1. Treat the original technical facts and canonical identifiers as immutable.
2. Identify each engineering concept from its context, not from an isolated
   English word.
3. Use the approved Chinese term in
   [references/terminology.md](references/terminology.md) when the content
   includes software development, testing, build, release, deployment,
   acceptance, incident, or recovery terminology.
4. Preserve distinctions between similar concepts. Do not merge terms merely
   to make the Chinese sound simpler.
5. Return the localized explanation without adding execution advice that was
   not present in the source content.

## Preserve canonical data

Keep these values unchanged unless the user explicitly requests a translated
copy in addition to the original:

- commands and command output;
- configuration keys, schema fields, and machine-readable status values;
- code symbols, API names, model names, service names, and product names;
- paths, URLs, IDs, hashes, revisions, tags, versions, and digests;
- raw errors, stack traces, and quoted source text.

Add Chinese explanation beside canonical data instead of replacing it. For
example:

```text
status: blocked
说明：当前流程处于阻塞状态。
```

## Ambiguity

If an approved Chinese term does not exist or the context is insufficient,
retain the English term and add a concise Chinese explanation. Do not invent a
translation that could change the engineering meaning.

Use a bilingual first mention when it prevents ambiguity, such as
`构建来源证明（attestation）`. Later mentions may use the established Chinese
term consistently.

## Output check

Before returning localized content, confirm that:

- no technical fact, state, sequence, or decision changed;
- no new action or gate was introduced;
- commands and machine-readable values remain intact;
- distinct engineering concepts remain distinct;
- the Chinese wording is professional and natural for a software team.
