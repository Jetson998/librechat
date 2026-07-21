# PPT Single-Turn Artifact Diagnosis

Date: 2026-07-21

Scope: LibreChat production conversation only. This record does not cover
WebAI, OpenWebUI, or another project.

## Incident

- Conversation: `a0dc9c6f-ce21-4fae-ab0d-0e8ab25bb108`
- Final user message: `3fc3b781-86d4-4669-91be-bf5297e3c846`
- Assistant message: `628c9037-d4ad-4cf6-881a-1f79a46049dd`
- Model: `gpt-5.6-sol`
- User request: generate and return the previously agreed PowerPoint.

The customer requested one complete presentation. The customer did not ask for
one PPTX per slide, individual slide images, SVG exports, or QA JSON files.

## Observed Result

The main deliverable was generated successfully:

- `paymatrix_aml_ppt/Paymatrix_反洗钱独立审计服务介绍_v1.0.pptx`
- 17 slides
- 810,384 bytes
- generated at `2026-07-21T15:34:01Z`
- persisted as file ID `6c3be8fe-bbc3-4c3b-94af-b5429b0ec888`

The assistant message completed at `2026-07-21T15:35:44Z` with 51 attachments.
After a page refresh, the complete PPTX download card was visible. Before the
refresh, the browser still displayed the previous Fable branch.

The 17 in this incident is the slide count, not a reasonable default artifact
count. A 17-slide presentation normally produces one PPTX file.

## Unrequested Artifacts

After the complete 17-slide PPTX already existed, the model performed additional
work that was not requested:

1. Exported PDF, PNG, SVG, and JPG variants.
2. Split the complete deck into 17 separate single-slide PPTX files.
3. Rendered 17 individual slide PNG files.
4. Generated a montage and several manifest, preflight, extraction, error, and
   QA JSON files.
5. Attached these internal files to the assistant message alongside the actual
   customer deliverable.

This behavior increased latency, produced a noisy file surface, and obscured the
primary download. The single-slide PPTX files were internal QA by-products, not
customer deliverables.

## Direct Cause

The assistant explicitly loaded the personal Skill `cyber-ppt` before
generation. Its production definition makes the following a default mandatory
workflow:

- produce one single-page PPTX per slide;
- render and validate each page separately;
- obtain per-page user confirmation;
- merge the approved single-page PPTX files into a final deck.

That workflow is designed for a specialized, high-fidelity, multi-stage
production engagement. It is not appropriate as the default behavior for a
normal request to return one already-agreed presentation.

The actual run did not follow the Skill's own confirmation gates. It generated
the complete deck first and then retroactively split it into 17 single-page
files for QA. This delivered the cost and attachment volume of the specialized
workflow without its intended user-review process.

## Skill Integrity Problems

The production `cyber-ppt` record has `fileCount: 0`, but its body requires these
files before work can continue:

- `references/source-analysis.md`
- `references/storyline.md`
- `references/visual-system.md`
- `references/ppt-production.md`
- `references/quality-assurance.md`

All five reads failed, and the model repeated the failed reads. Therefore the
Skill's mandatory Reference Gate cannot be satisfied in production.

The Skill also mandates PptxGenJS and prohibits `python-pptx` for final PPTX
generation. The CodeAPI session reported that `node` and `pptxgenjs` were not
available, while `python-pptx` was available. The assistant then used
`python-pptx`, contradicting the loaded Skill.

These are configuration and runtime compatibility defects in the Skill, not a
failure of LibreChat's core PPTX generation or file persistence path.

## Root-Cause Classification

1. **Skill selection mismatch**: a specialized multi-stage Skill was loaded for
   a normal one-file delivery request.
2. **Broken Skill package**: mandatory reference files are absent.
3. **Runtime mismatch**: the required JavaScript PPT engine is unavailable.
4. **Unbounded artifact discovery**: every generated CodeAPI file was treated as
   a visible assistant attachment.
5. **No deliverable classification**: customer deliverables and internal QA
   files share `context: execute_code` and are not separated by role.
6. **Frontend freshness issue**: the completed GPT branch became visible only
   after refreshing the conversation page.

## Correct Product Contract

For an ordinary request such as "output the PPT":

- 17 slides means one 17-slide PPTX, not 17 PPTX files.
- One reply defaults to one complete visible deliverable.
- A reasonable explicit multi-format request may expose at most three files.
- More than three independent files is not supported in one reply. The user
  must split the task or request one complete deliverable.
- ZIP is not supported as a fallback for an oversized result set.
- Intermediate JSON, per-slide renders, compatibility probes, and temporary
  single-page decks must remain hidden from the customer file surface.

## Repair Boundary

No production repair was applied during this diagnosis.

A governed repair should address these boundaries separately:

1. Do not auto-select `cyber-ppt` for ordinary PPT generation. Reserve it for an
   explicit high-fidelity, per-page review workflow.
2. Repair or disable the incomplete Skill until all mandatory references and its
   required runtime are present.
3. Add an artifact role such as `deliverable`, `preview`, or `intermediate` to
   generated CodeAPI files.
4. Show only `deliverable` files as normal download cards. Keep intermediate QA
   files available for diagnostics but hidden by default.
5. Stop optional QA after a bounded validation of the complete PPTX. Do not split
   a finished deck into customer-visible per-slide files. If a user asks for
   more than three independent files, ask them to split the task instead.
6. Add a generated-files view under My Files, filtered to user-visible
   deliverables and isolated by owner. Listing a file must not automatically add
   it to another conversation's model context.
7. Verify that the client selects or refreshes to the latest completed branch
   without requiring a manual page reload.

## Acceptance Requirements

A future fix is not accepted until one fresh authenticated conversation proves:

- one user turn requests a multi-slide PPT;
- the source Office files are restored into CodeAPI;
- one complete PPTX is generated and downloadable;
- no unrequested single-slide PPTX files appear as customer attachments;
- visible attachments remain within the expected delivery set;
- internal QA files remain hidden but auditable;
- no ZIP fallback is offered;
- the result appears without a manual page refresh;
- Mongo records preserve user ownership, conversation identity, artifact role,
  and the final assistant attachment references.
