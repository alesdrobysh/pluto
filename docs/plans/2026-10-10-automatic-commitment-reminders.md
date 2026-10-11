# Automatic reminders for dated commitments

Status: implementation complete locally; native acceptance partially verified.
Remaining manual checks are listed below. Not released.

## Implementation record — October 10, 2026

- Added confirmed-commitment scheduling, calendar-aware deadlines, bounded catch-up,
  durable claims/retry history, and migration `0019`. Existing verified aliases
  carry identity continuity; uncertain replacements stay unscheduled.
- Added one main-process timer with indexed deadline-window reads, mutation/wake
  reconciliation, and a fifteen-minute recovery sweep. No model calls, context
  expansion, renderer polling, or changes to commitment confirmation rules.
- Fixed demonstrated relative-date extraction drift: normalization uses the meeting
  date instead of the later extraction date. Ambiguous strings remain unscheduled.
  An original local timezone cannot be reconstructed from a UTC-only meeting stamp.
- Added default-on reminders, default-visible details (private previews remain optional), canonical date correction
  and removal, and notification navigation that waits for the current renderer.
- Electron 40's notification implementation lacks the required permission API.
  A small macOS Node-API bridge uses `UNUserNotificationCenter` for permission,
  immediate submission, cancellation, and clicks. It never schedules future OS
  delivery. The delegate is installed before database unlock to retain launch
  clicks; resolving their context still waits for application readiness.
- The October 10 decision in `docs/decisions.md` narrows the September 12 calendar
  alert decision; existing calendar/call alerts remain on their existing path.

Synthetic performance measurement used 50,000 fictional actions and 50,000
attention rows: initial scheduling 16.27 ms, routine recovery median 2.21 ms
(p95 3.34 ms), mutation invalidation about 12.2 ms, and eight fake submissions
4.22 ms. Initial discovery used one indexed query returning ten relevant rows;
routine recovery and mutation invalidation issued no deadline-catalog query.
These are Node in-memory SQLite measurements, not encrypted-disk or native OS
latency claims. Private scripts and reports remain under ignored `.private/`.

The ledger deliberately prefers a missed alert over a duplicate after a crash
between a durable claim and OS submission. `submitted` means accepted by the OS,
not displayed or read. Pluto must remain running; system notification settings
and Focus can suppress presentation.

### Verification record

- Integrated suite: 6,454 tests passed across 513 files before the final
  date-only Dashboard correction. TypeScript, standard lint, and production
  renderer/main/preload builds passed. The final correction passed all thirteen
  focused database tests under Electron, TypeScript, and lint. Its query plan
  retains the deadline index. A fresh package includes that correction.
- Fresh signed arm64 package passed all seven packaged runtime checks. Private
  profiles, probe identifiers, and experiment paths are absent from its app archive.
  Electron SQLite ABI was restored before native verification.
- A separate branded fictional native probe reported authorized permission,
  successful OS submission, and a real native click callback restoring its hidden
  window to the fictional commitment.
- The full packaged application, using an isolated fictional database, created
  exactly one `submitted` ledger row for the confirmed item and none for a possible
  item. Restart retained one attempt and the same submission timestamp. Dashboard
  completion changed canonical status while preserving delivery history. The
  settings off switch persisted and could be restored. A subsequent launch after
  reopening the delivered commitment still retained its original single attempt;
  a separate future commitment had a pending row with zero attempts.
- Follow-up packaged UI acceptance passed: today's date-only commitment no longer
  displays as overdue. Completing a future commitment changed its reminder from
  pending to cancelled with zero attempts. Editing a delivered commitment's date
  created a new pending revision; removing that date cancelled the pending revision
  and preserved the earlier submitted history. Read-only database inspection
  verified each UI-driven transition.
- A fresh packaged end-to-end fixture with an explicitly confirmed other owner
  submitted exactly one reminder for that owner's commitment. This occurred while
  the personal Dashboard showed five different commitments, confirming reminders
  are not limited to the Dashboard selection. Prioritizing a sixth personal item
  retained exactly five persisted ranks and moved the displaced item to the backlog.
  All 220 focused reminder, navigation, and Dashboard tests passed under Electron;
  the fresh package passed all seven runtime checks.
- Production eligibility was measured with an explicitly read-only SQLCipher
  connection and `query_only` enabled. No migrations, scheduler, model calls,
  settings changes, or production writes were performed. Private aggregate counts
  and the current eligibility outcome remain in the ignored acceptance report;
  the confirmation boundary was preserved. Synthetic delivery acceptance does not
  establish that existing extracted work supplies confirmed, dated opportunities.
- The full-app fixture uses a local protocol stub solely to avoid loading
  transcription models during reminder testing. These checks do not certify
  recording or model behavior.

Remaining native acceptance boundaries: the computer-use tool refuses access to
the macOS permission-dialog application, so an explicit user-denial interaction
could not be completed. Denial/no-repeat behavior is covered by automated tests.
Physical sleep/wake was not performed because the user requested keeping the Mac
awake; clock recovery, wake wiring, and stale catch-up are covered in code/tests.
Cold-launch notification clicks still need direct native acceptance. Notification
Center automation exposed only its widget surface during the follow-up check, so
full-app notification-click navigation is not newly claimed as verified.
No confirmation/ownership rules were weakened to improve apparent coverage.
The earlier locked-Mac limitation was resolved on continuation: final visual and
pending-item cancellation checks now pass as recorded above. Sleep prevention
remains running at the user's request. Do not describe the remaining native OS
checks as fully certified. No production profile was migrated, no release was made,
and no commit or push was performed.

## Goal

Turn meeting commitments into timely follow-through: Pluto automatically reminds
the user when an open commitment with a trustworthy due date needs attention.
Clicking the notification returns to the commitment and its source meeting,
supporting the continuing meeting-note workflow.

There is no per-item “Remind me” action, scheduling form, or extra acceptance
step added for reminders. No Slack, email, or Apple Reminders integration.
Apple Reminders is an interaction reference, not an integration requirement.

## Product rules

- Enable automatic reminders by default, subject to macOS notification permission.
  Offer one global off switch in existing settings. Request system permission in
  context when the first eligible commitment exists; remember the result and do
  not repeatedly prompt after denial. Verify the permission mechanism in the
  packaged macOS app before choosing an implementation.
- Reuse the existing confirmed-commitment boundary. Reminder eligibility must not
  promote `possible` candidates, infer ownership, or add another review gate.
  Commitments already confirmed through existing supported paths qualify
  automatically. A due date alone does not establish that a suggestion is an
  accepted obligation. Measure how much real extracted work qualifies; if this
  boundary prevents the desired automatic experience, report it rather than
  silently weakening ownership rules.
- Include both the user's work and confirmed commitments owed by others. For
  others, notify the Pluto user to follow up; do not notify the other person.
  Use owner-specific copy only when the existing identity evidence supports it.
- Require an active, non-retired, non-rejected commitment and a valid canonical
  due date. Exclude completed, deleted, superseded, and deferred/suppressed work
  using the existing lifecycle semantics. Unknown or ambiguous dates do not
  produce reminders. No invented deadlines or additional model call.
- Start with one notification per commitment and due-date revision, at 9 a.m.
  local time on the preceding calendar day. If that time has passed when the item
  first becomes eligible, schedule at 9 a.m. on its due day; if that has also
  passed and the item is due today, deliver once when eligible. Never send a
  reminder after an explicit deadline timestamp has passed. These are proposed
  defaults, not user-selected times.
- Treat date-only deadlines as calendar dates, never UTC midnight. Preserve
  explicit timestamp offsets. Verify relative-date normalization against the
  meeting date and timezone; unsupported legacy strings stay unscheduled.
- Do not backfill notifications for commitments already overdue when this ships.
  On startup or wake, catch up only if the current deadline is still relevant
  (date-only: due today or later; timestamp: still in the future). Skip stale
  reminders rather than sending an overdue backlog. No repeating overdue nudges.
- Completion, rejection, deletion, retirement, date removal, or disabling reminders
  invalidates pending delivery. Due-date edits replace the pending schedule.
  Reopening the same commitment does not resend an already-delivered reminder
  for the same deadline. A materially different deadline may generate one new
  reminder; formatting-only date changes may not.

First-version delivery requires Pluto's main process to be running, including
with the main window hidden. Fully quitting Pluto stops delivery; the next launch
applies the bounded catch-up rules. Do not claim Apple Reminders-style delivery
while quit. OS-owned scheduling while quit is a separate native lifecycle project,
including cancellation while data is locked, packaging, and notification routing.

## Existing implementation seams

Source inspection found:

- `electron/db.ts`: action entities already carry `due_date`, `assigned_to`, status,
  and metadata; `upsertEntity` supports explicit date removal.
- `src/utils/actionCommitment.ts`: `possible`, `confirmed`, and `rejected` review
  states; missing review state defaults to `possible`.
- `electron/db.ts`: `updateEntityStatus` synchronizes completion into canonical
  meeting notes. `updateActionCommitmentState` handles existing review transitions.
  `retireMeetingDerivedCommitments` marks superseded extraction generations.
- `electron/commitmentReconciliation.ts` and `electron/commitmentIdentity.ts`:
  existing reconciliation/identity rules must determine continuity across
  regeneration. New entity IDs must not alone authorize duplicate reminders.
- `electron/main.ts`: notes-ready notifications use Electron `Notification`.
  Existing main-process lifecycle and window navigation are integration points.
- `src/components/features/projects/ProjectCommitments.tsx`: existing commitment
  completion UI and date presentation. Its legacy metadata date fallback is not
  sufficient evidence for scheduling; normalize and validate through one shared
  canonical rule.

Graph tools were unavailable during planning; these findings come from targeted
source reads. Recheck the working tree before implementation: it contains
unrelated in-progress application changes that must be preserved.

## Implementation sequence

### 1. Establish eligibility and date behavior

Create a small pure main-process policy module, for example
`electron/commitmentReminderPolicy.ts`, with an injected clock and timezone.
Return eligible schedule data or an explicit exclusion reason. Reuse existing
retirement, review, ownership, and lifecycle helpers rather than duplicating
their rules. Trace completion from all existing surfaces and establish which
canonical date/identity fields survive reconciliation before adding storage.

Verify the due-date extraction path using fictional meetings: an explicit date,
a relative date with meeting context, an ambiguous date, and a later changed
deadline. Fix only a demonstrated canonical normalization gap, with regression
coverage; do not broaden extraction or change model budgets as part of this work.

### 2. Persist delivery state in the encrypted database

Add a migration through the existing migration system for a small reminder ledger.
Persist the canonical commitment/obligation identity, normalized deadline revision,
scheduled instant, state, and attempted/submitted timestamps. Enforce uniqueness
for the same obligation and deadline. Preserve enough history to prevent resends
after restart, completion/reopening, or equivalent notes regeneration.

Use existing verified reconciliation mappings to transfer continuity. Do not
introduce name-only or fuzzy-text deduplication. When continuity cannot be
established safely, withhold a replacement reminder pending reconciliation rather
than guessing identity or immediately emitting another alert.

Entity and source-note state remain authoritative. The ledger tracks notification
delivery only and must not become a second task or completion store. Avoid copying
meeting text into notification logs or ledger records unnecessarily.

### 3. Add a main-process scheduler and system notification adapter

Create a bounded scheduler, for example `electron/commitmentReminderScheduler.ts`.
Reconcile after DB readiness, successful commitment publication/reconciliation,
relevant mutations, settings changes, and wake. Use a periodic bounded sweep as a
recovery path for missed hooks and clock/timezone changes; do not poll the renderer
or run a database read on every renderer render. Query only relevant deadlines.

Use one timer for the next eligible delivery with periodic resynchronization.
Serialize dispatch and use durable claims to prevent overlapping sweeps. Re-read
the current commitment immediately before notification submission. Cancel
invalidated notifications where the selected adapter supports it.

Document the crash window between database state and OS submission. Do not claim
exactly-once visible delivery: prefer avoiding duplicate alerts, record ambiguous
attempts, and distinguish “submitted to OS” from “seen by user.” Handle explicit
adapter errors with bounded retry while the deadline is relevant; permission
denial and unsupported notifications must not create a retry loop.

Use Electron system notifications if packaged-app permission, click handling, and
lifecycle tests pass. Do not reuse the transient call/calendar alert window for
deadline reminders. Before shipping, append a decision entry explicitly narrowing
the broad notification-unification language in the accepted September 12, 2026
calendar-alert decision; retain its existing call/calendar behavior.

### 4. Return the user to actionable context

Use concise copy such as “Revised estimate is due tomorrow” or, for a verified
other owner, “Follow up with Alex: revised estimate is due tomorrow.” A privacy
preview preference should allow generic text such as “A commitment is due
tomorrow”; respect any existing global notification privacy preference first.

On click, reveal/focus Pluto and navigate through its existing route flow to the
current commitment and source meeting. Wait for renderer readiness, resolve
superseded identities, and handle deleted sources gracefully. Do not open a stale
meeting ID or change completion simply because a notification was clicked.

Use existing completion and due-date controls inside Pluto. No per-item reminder
setup or notification-action buttons are required for this first version. If the
current surfaces lack a reliable date correction/removal path, add a compact one
using canonical updates rather than a separate reminder editor.

### 5. Verify and record the actual delivery boundary

Focused tests with a fake clock and fictional data must cover:

- Confirmed versus possible/rejected work, verified other-owner wording, and
  completed/deleted/retired/deferred exclusions.
- Date-only and timestamp deadlines, timezone changes, DST transitions, relative
  date normalization, invalid dates, same-day extraction, and stale catch-up.
- One reminder per obligation/deadline across repeated sweeps, restarts,
  completion/reopening, and regenerated entity IDs with verified continuity.
- Date changes/removal, completion from each existing surface, reconciliation,
  and global disablement between scheduling and dispatch.
- Permission denial, explicit notification failure, ambiguous crash recovery,
  DB unavailable/locked state, and renderer-not-ready navigation.
- Migration of an existing database without changing commitments or source notes.

Run the focused new suites plus existing commitment identity/reconciliation,
database action-commitment, completion-sync, and migration tests. Run TypeScript,
lint for changed files, and the required SQLite ABI restoration before Electron
checks. Broaden checks only when the change warrants it.

In a packaged macOS build, verify permission allow/deny, actual OS presentation,
click navigation, hidden-window delivery, sleep/wake, restart deduplication,
completion cancellation, and fully-quit catch-up. Use fictional fixtures only.
Automated tests cannot establish native delivery acceptance.

## Completion criteria

A confirmed dated commitment automatically produces one timely system reminder
without reminder setup. Clicking it restores the relevant context. Lifecycle
changes stop stale delivery, regeneration does not repeat the same reminder,
uncertain work does not become an obligation, and the global off switch works.
Document packaged-app results and any remaining OS delivery limitations before
marking implementation complete. Commit, push, and release only when requested.
