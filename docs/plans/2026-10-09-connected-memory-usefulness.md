# Connected-memory usefulness: implementation closeout

Status: **ready for the next release**, October 10, 2026. The retained changes
across People, Projects, Notes, Ask Pluto and Dashboard are implemented and
locally verified. Independent Sol-medium review found no remaining must-fix in
this change set. This is the launch decision for these improvements, not a claim
that every broader model-quality aspiration is solved.

The subsequently requested automatic-reminder feature is tracked separately in
`2026-10-10-automatic-commitment-reminders.md`. Its new scheduler, native bridge,
and acceptance status are outside this original change-set closeout.

## Product outcome

Make accumulated meeting history easier to resume, understand and use without
adding latency to saved views or generation. Improve existing surfaces before
adding features, background jobs or infrastructure.

The initial review inspected the installed app's dashboard, meeting library,
project and person profiles, saved notes and saved conversations. It found
misleading brief status, buried unresolved questions, weak quiet-week
orientation, rows emphasizing counts rather than relationship context, and
judgments that treated participation as evidence of performance. Historical
saved answers informed diagnosis; fresh fictional cases were used for testing.
Production names, counts, meeting content and screenshots remain private.

## Delivered scope

| Surface | Result | Acceptance |
| --- | --- | --- |
| Projects | Existing structured questions survive the bounded synthesis input. Missing and outdated briefs use their actual state instead of implying nothing is unresolved. Removed a warning that incorrectly inferred staleness from source counts. | Focused regressions and a fresh fictional V3 changed-state synthesis retained the relevant question, owner change, rejected option and conditional work. No new saved-view read or generation dependency. |
| Dashboard | Quiet weeks show a dated last-conversation continuation using data already loaded, with the existing route to that meeting. | Rendering and navigation checked; recording and populated recent-win behavior preserved. No new request or activity invented to fill space. |
| Notes | Derived overviews lead with audited decisions and owned actions and preserve sentence boundaries. Discussion remains in the body; it is no longer elevated into a topic summary merely because it came first. | Captured fictional drafts replayed through the actual renderer document builder. Original point text, action/decision text, conditions and source spans preserved. Explicit reviewed overviews and narrative-only behavior retained. |
| People | Current saved relationship headlines appear in rows, falling back to the existing meeting cue. Existing preparation and person-scoped chat remain available. | Current/stale/missing states and existing navigation covered. No personality inference, new query or generation. |
| Ask Pluto | Neutral copy when suggestions are unavailable. One coherent response contract separates recorded work from unsupported performance judgments. Meeting occurrence labels no longer substitute an import timestamp. | Normal-budget factual, technical, drafting, supported-result and thin-evidence cases passed for the retained contract; clean balanced timing pairs passed. Citation identities, routing, trust rules and budgets preserved. |

No recording, transcript, source data, user classification or production setting
was rewritten. Existing saved notes are not silently regenerated or backfilled.
The Notes projection improvement applies when the existing generation path next
produces a document.

## Edit preservation

Independent review caught an ambiguity where an overview and a decision could
have identical text and evidence. The final implementation does not duplicate
outcomes as topic summaries. It distinguishes the overview's edit source key
from a canonical outcome's key with one overview-only prefix. Other source keys
and the existing rebase algorithm remain unchanged.

Regressions use the actual `getAnalysisEditBlocks` publication path, not a mock
identity scheme. They verify separate overview/outcome edits reattach and a
former narrative-summary edit follows its point into the body. No new lineage
checking, persistence schema or rebase subsystem was introduced.

## Performance decision

The retained changes add no model passes, larger context defaults, polling,
background synthesis jobs, transcript hydration or full-corpus scans to saved
views. UI changes reuse loaded data. Notes presentation performs bounded
in-memory selection and string handling on the existing audit result.

The accepted general Ask contract retains 4,096 input-context / 768 output-token
settings and existing routing. Three clean balanced AB/BA/AB trials on the same
fictional analysis fixture measured:

| Median | Before | After |
| --- | ---: | ---: |
| Completion | 22.618 s | 17.153 s |
| First token | 9.389 s | 9.168 s |
| Native prompt processing | 8.607 s | 8.287 s |
| Native decode | 13.192 s | 7.935 s |

Cold warmup and contended attempts were excluded. Completion improved 24.2% in
this bounded case, with no first-token regression. This is not a universal
speedup or recording-under-load certification. Notes retains its 16K writer
context and existing call count.

## Verification

- Integrated full suite: **6,375 tests passed across 506 files**.
- Final Notes/editor/publication regressions: **176 tests passed across seven
  files**, including actual extraction and edit-rebase behavior.
- TypeScript and production renderer/main/preload builds passed.
- Standard **`pnpm run lint` passed**, checking 1,246 files. Biome now excludes
  ignored private experiment artifacts and generated packaged Electron output,
  consistent with its existing exclusions for other build outputs. No source
  rule was weakened. Full Biome checks passed for all 29 changed/new TypeScript
  files; `git diff --check` passed.
- A fresh local arm64 package passed signature, entitlement, icon and six native
  runtime checks. It reached onboarding in a new isolated standard-storage
  profile and quit cleanly. The package contains no private experiment paths.
- Electron SQLite ABI was restored and verified. The installed app remained
  running, and its profile was not modified.
- Independent Sol-medium integration review: **go; no remaining must-fix in the
  retained changes**.

The package smoke verifies startup. Earlier populated fictional navigation
checks cover the affected views; it does not mean live capture, production-data
accuracy or every provider flow was newly certified. No runtime changes were
made after the final package check; the closeout only adjusts lint exclusions
and documentation.

## Known limitations and excluded experiments

These are existing model limitations, not regressions introduced by this change:

- Generated Notes can still omit material details or misstate final state inside
  the body. Presentation improvements do not repair every generated assertion.
- Person/global answers can still miss historical handoffs or misinterpret
  source-relative deadlines. Reliable historical responsibility recall remains
  future quality work.

Writer and chronology candidates were rejected when they lost conditions,
coverage, deadlines or ownership accuracy. The final chronology candidate fixed
one timezone case but omitted a deadline preserved by the unchanged baseline at
the same budget. It is excluded. No person-chat ordering/prompt change, larger
model/context default, extra model pass or new scheduling machinery is retained.
Detailed fictional experiments and the prior chronological implementation record
remain local and ignored. They are not release artifacts.

## Delivery decision

**Proceed with the normal release workflow for this change set.** Further prompt
experiments are not a prerequisite to releasing these verified improvements.
The limitations above remain explicit; the broader semantic aspirations must
not be advertised as solved.

Suggested product summary: Projects retain useful open questions and clearer
brief status; People and Dashboard make past conversations easier to resume;
Notes leads with recorded outcomes while preserving discussion and edits; Ask
Pluto is more restrained about unsupported performance judgments.

The work is local and uncommitted. Nothing was pushed, published or installed
over the production app. When publication is requested, use the existing
[release workflow](../releasing.md), including its clean/synced checkout and
release-CI checks. This document does not create a new approval procedure.
The separately drafted automatic-reminder plan is outside this change set.
