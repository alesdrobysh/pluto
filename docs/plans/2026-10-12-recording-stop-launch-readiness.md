# Recording shutdown and launch readiness

Status: proposed implementation and acceptance plan. No runtime changes made by this document.

## Outcome and corrected diagnosis

The reporter confirmed that they clicked **End meeting**, but audio remained active until Pluto was killed. Treat failure to release capture after an explicit stop as a public-launch blocker. Missed automatic departure is a separate reliability concern, not the leading explanation for this incident.

The code review establishes defects and missing guarantees; it does not establish which one occurred on the reporter's machine. The exact build, device route, and stop-stage evidence are unavailable. Reproduction and fault injection must cover the alternatives without depending on more reporter answers.

| Evidence | Assessment | Required response |
| --- | --- | --- |
| `AudioManager.stopSession` awaits the microphone recorder's `onstop` before invoking native stop. The wait has no deadline. | Confirmed unbounded dependency. A missing event can leave system capture running. | Start resource shutdown independently and bound recorder completion. |
| Early stop failures can reach UI reset without a guaranteed resource cleanup pass; callbacks before the main `try` can also interrupt the operation. | Confirmed cleanup gap. | Put all accepted-stop work under a guaranteed cleanup boundary. |
| Main-process stop clears the AudioCap handle before sending `SIGINT`, and IPC reports success without observing exit. | Confirmed missing termination acknowledgement and fallback. Whether AudioCap ignored the signal in this incident is unknown. | Retain ownership until verified exit; escalate only the owned process within a deadline. |
| The native signal handler logs and calls `exit`, without explicitly running `ProcessTap.stop`. | Cleanup relies on process termination. This alone does not prove a macOS resource leak. | Audit signal safety and explicitly stop native resources on the normal shutdown path. |
| Active-meeting deletion stops the recorder but omits track cleanup. | Confirmed adjacent cleanup gap; not the reported trigger. | Use the same resource cleanup primitive with deletion-specific persistence behavior. |
| Auto-end announces completion without awaiting stop. | Confirmed reporting gap; not the explicit-stop trigger. | Consume actual capture-stop results. |
| Idle call detection launches separate AudioCap probes. | Confirmed additional source of audio access; its role in the observed indicator or playback failure is unproven. | Distinguish recording capture from probes and test both after End meeting. |
| The report says music could not play. | Unresolved hardware symptom. Neither an active privacy indicator nor code review establishes the output-route cause. | Reproduce playback and device-route behavior independently of the indicator. |

Earlier verification passed 54 tests across detector, decision, monitor, native-readiness, and stop-boundary suites. These are a baseline, not shutdown or packaged-hardware acceptance.

## Product contract

1. End meeting immediately freezes the recording end time and prevents new capture/recovery admission for that recording generation.
2. Microphone and system capture stop independently of transcription, notes, database writes, and journal sealing. Failure in one cleanup step must not skip the others.
3. “Recording stopped” requires verified resource release. “Meeting saved” requires a separate persistence result. A failure to save must never keep the microphone or system tap alive.
4. Preserve all durable pre-stop audio and provenance. Drain already admitted final chunks within a bounded window; record any missing tail honestly. Do not discard the final utterance merely to hit a shutdown target, and do not capture fresh post-stop audio while waiting for processing.
5. Repeated stop requests share the same operation. An old callback cannot stop, restart, clear, or announce success for a newer recording.
6. Unknown call state, silence, mute, and calendar end are insufficient reasons to stop a meeting.
7. A user must not have to kill Pluto to release capture. If automatic release cannot be confirmed, show an actionable failure and retain enough ownership to retry; never silently mark capture idle.

Proposed acceptance targets, to be measured on supported packaged macOS builds: ordinary click-to-resource-release p95 at most 1 second; injected recoverable stalls release within a 5-second overall stop budget. A forced exit or failed release is an explicit outcome, not ordinary success. These budgets are engineering targets, not guarantees against an unresponsive operating system. OS privacy-indicator retention is measured separately from actual process and resource lifetime.

## Delivery sequence

### 1. Establish a reproducible stop baseline and useful evidence

Own the work in an isolated branch from the latest agreed integration base; the current checkout contains unrelated work. Reproduce with fictional recordings and a disposable profile. Record the tested app build, native-helper build, macOS version, and audio-device class.

Extend the existing bounded capture diagnostics rather than creating a second telemetry system. Record fixed event codes and relative timings for:

- stop requested and accepted, including manual/automatic/deletion/abort/quit reason;
- microphone stop requested/completed/timed out and track release;
- native stop requested, normal exit, escalation, exit confirmed, or release failed;
- recovery/probe admission cancelled, active child counts by purpose, and stale callback rejection;
- capture released, journal drained/sealed or recovery required, and UI acknowledgement.

Keep raw URLs, window text, meeting content, device names, paths, process IDs, and participant identity out of exported diagnostics. Use session-local correlation counters and fixed categories. Diagnostic writes must not delay stop or turn a failed disk write into a cleanup failure. Include a bounded recent stop summary even when a meeting could not be saved, so a report can be useful without live questions to the reporter.

Create deterministic reproductions for a missing recorder event, recorder exception, hung AudioCap, IPC failure, and pending recovery at stop. Measure whether the post-stop privacy indicator comes from the original recording child, an in-flight probe, a new probe, or only macOS's recent-use display.

Exit criterion: each suspected mechanism has a reproducible test or is explicitly marked hardware-only/unconfirmed. Do not delay the confirmed shutdown fixes while waiting to reproduce the reporter's exact machine.

### 2. Make audio resource shutdown bounded and verifiable — launch blocker

Primary scope: `src/components/AudioManager.tsx`, `electron/nativeAudioCapture.ts`, native IPC handlers in `electron/main.ts`, and `resources/swift/audiocap/`.

- At accepted stop, cancel recovery/device-reconfiguration admission before the first awaited operation. Put callbacks and cleanup under a boundary that survives synchronous exceptions.
- Request microphone recorder completion and native shutdown independently. Use one overall stop deadline; do not stack several full-length timeouts serially.
- Request the final microphone chunk and drain already admitted PCM. Bound the recorder-event wait, then stop every owned media track, disconnect processors/samplers, and close owned audio contexts even when recorder completion fails. Cover visualization streams as well as the primary microphone stream.
- In Electron, retain the exact child reference and generation while stopping. Wait for actual termination. Attempt graceful shutdown, then bounded termination/force-kill escalation if needed. Signal only that owned child, never processes found by name or stale PID alone.
- Keep native stopping state until exit is confirmed. If confirmation fails, return a failure outcome and reject overlapping capture startup. Handle already-exited children, spawn errors, duplicate stops, and signal failures without leaking listeners or timers.
- Run Swift tap, IOProc, aggregate-device, timer, and route-listener cleanup on a safe control path. Avoid non-signal-safe logging/cleanup inside a raw signal handler. Ensure parent loss also releases the helper; choose the smallest testable mechanism compatible with the current process transport.
- Preserve final buffered bytes and journal receipts while closing transport; do not clear the reference/subscription so early that valid pre-stop tail data disappears. Fence late events against newer sessions.

Exit criterion: all injected stop failures release resources or return an explicit release failure within the target budget. No branch reports successful release merely because a signal was sent. Successfully stopped sessions can immediately record again.

### 3. Apply the same guarantees to the entire lifecycle — launch blocker

Reuse the existing capture lease, journal, and recovery mechanisms. Add only the stopping state and generation checks needed for correctness; do not rewrite the whole recording architecture.

- Route manual stop, automatic stop, failed startup, active-meeting deletion, component teardown, renderer destruction/crash, app quit, and update restart through the shared resource shutdown primitive.
- Keep persistence policy distinct: normal stop seals and saves; deletion respects the requested deletion; aborted startup preserves only evidence required by existing recovery policy. Resource release must happen in all cases.
- Separate resource stopping from journal sealing. A lease can retain authority to drain pre-stop chunks while rejecting new capture starts. Do not mark the journal stopped prematurely if that rejects legitimate tail writes.
- Give native recovery a distinct restart intent. A recovery stop may restart only the same active generation; terminal stop revokes that permission in the main process as well as the renderer. Test a start already in flight when End meeting arrives.
- Audit all capture and probe children. Cancel owned in-flight probes during terminal shutdown and prevent repeated automatic probes for the same dismissed/ended call from immediately reacquiring audio. Define re-arming on a positively observed new call or explicit user action; do not silently disable discovery forever.
- If safe post-stop probing cannot be demonstrated, use passive discovery or gate that automatic probing feature for launch. Explicit user-requested permission checks remain a separate operation with their own bounded lifetime.
- Keep stop UI truthful: show stopping until capture is released, then processing/saved/recovery-required as appropriate. Auto-end logs and notifications use the acknowledged capture result. A release failure has a working retry action; a long transcription does not imply continued recording.
- Preserve local journals after crashes and verify recovery on restart. Startup diagnostics must not kill unrelated apps or another Pluto instance's helper.

Exit criterion: the same shutdown invariants hold through every lifecycle entry point, including stop/recovery/start races and failed persistence. No stuck stop poisons the next meeting.

### 4. Verify audio playback and route recovery — launch blocker

Test the built installer, not only a development Electron session. Use built-in audio, a wired/USB device, and Bluetooth headphones. Exercise device changes immediately before and during End meeting, Bluetooth disconnect/reconnect, mute/unmute, and sleep/wake.

For each run, separately record:

- microphone tracks and AudioCap/probe child exit;
- native tap/aggregate cleanup where observable;
- system output route before/during/after recording;
- playback audibility, output volume, and Bluetooth audio mode/quality;
- privacy indicator behavior, including macOS recent-access display;
- preserved final utterance, saved duration, and immediate next-recording success.

Do not reset the user's global audio devices, volume, or CoreAudio service as a workaround. Any route repair must be limited to resources Pluto actually changed and justified by reproduction.

Exit criterion: End meeting restores normal playback without quitting Pluto across the supported device matrix. A retained indicator with no active access is documented separately; active probes must not be mistaken for OS retention.

### 5. Finish automatic departure behavior as a separate workstream

Use [the existing departure plan](../follow-ups/meeting-departure-detection.md). It remains relevant to the initial auto-end complaint, but completing it is not evidence that explicit-stop cleanup is fixed.

- Bind call evidence to a source/session rather than the first unrelated app that looks active. Multiple tabs or ambiguous source identity mean unknown.
- Implement and validate Chrome/Meet and Zoom joined/left evidence first. Keep optional Accessibility consent distinct from browser Automation consent; background polling must not prompt for permission.
- Require two consecutive source-matched positive departure observations where specified by the existing plan. Joined, unknown, inspection failure, or source change resets confirmation. Treat helper restarts as a test case, not automatic proof of departure.
- Keep a single “Still in the meeting?” check-in after approximately two quiet minutes of inconclusive state. No response continues recording. End meeting uses the verified shutdown path.
- Show whether automatic ending is available for the current source/permissions. Validate Teams, Slack, and other browsers separately; do not promise reliable departure for an unvalidated adapter.

Launch decision: verified explicit stop is mandatory for every supported recording source. Broad automatic-departure claims require corresponding packaged acceptance. Unvalidated automatic adapters remain limited and clearly described; silence-based stopping is not an acceptable shortcut.

## Required regression and acceptance matrix

| Layer | Scenarios | Assertions |
| --- | --- | --- |
| Renderer unit/integration | Missing/late `onstop`, throwing `stop()`, rejected IPC, callback exception, closed context, missing recorder, duplicate stop | Native stop starts independently; every cleanup is attempted; truthful failure; bounded settlement; final valid data preserved. |
| Native-process integration | Normal exit, ignored graceful signal, force-kill, already-exited child, spawn failure, pipe backpressure | Actual exit acknowledgement; no child/timer/listener leak; no false success; exact ownership. |
| Concurrency | Stop during startup/recovery, delayed old start/stop response, rapid next meeting, deletion during stop | No resurrection, no cross-session stop, no stale success, no overlapping owners. |
| Persistence | Slow/failing writes, journal drain/seal failure, notes/transcription failure | Hardware already released; durable audio retained; recovery-required state remains honest. |
| Lifecycle | UI stop, auto-stop, deletion, abort, teardown, renderer crash, quit/update restart, parent termination | All owned capture resources released; saved/recoverable data matches the action. |
| Probes | Probe in flight at stop, idle detection after stop, unchanged open meeting tab, explicit permission probe | Bounded children, correct cancellation/re-arming, no repeated post-stop interference. |
| Departure | Tab left open, multiple tabs/apps, quiet break, revoked permissions, helper restart | No false stop; correct source; only confirmed departure triggers automatic stop. |
| Packaged hardware | Built-in, wired/USB, Bluetooth, route switches, sleep/wake, background/minimized app | Playback works, resource release meets budget, next recording works, capture tail remains intact. |

Add behavioral tests at the actual IPC/child-process boundaries. Existing source-string assertions can remain wiring checks but do not count as leak or timeout tests. Extend existing synthetic capture-continuity and native-health harnesses where practical; use fictional audio and disposable profiles throughout.

## Public-release gate and prevention of recurrence

1. Automated fault and race suites, types, lint, native build, and existing capture-integrity regressions pass on the candidate commit.
2. The exact packaged candidate passes on at least two physical supported Macs, spanning the oldest supported and current supported macOS versions. Use the shipped architecture and actual distribution/signing configuration; record untested combinations explicitly.
3. Run 100 automated start/stop/restart cycles with zero retained owned capture children or cross-session failures. Run at least 10 manual stop/playback cycles per device class across the physical matrix, plus a long meeting of at least one hour followed by stop and immediate restart. Observe memory/resource counts returning to baseline rather than accumulating.
4. No false “stopped” result, audio continuing after explicit stop, missing durable pre-stop audio, or reproducible playback interference remains open. Any occurrence blocks promotion and becomes a regression case.
5. A limited RC trial using that candidate completes at least 48 hours and 30 consented recording sessions across at least three testers, including Bluetooth and background-window use. Inspect content-free stop outcomes and any escalations; unexplained events hold promotion. A quiet trial alone is not proof of correctness.
6. Publish through the existing [release workflow](../releasing.md), beginning with its dry run from a clean synced integration branch. Do not promote stable solely because CI is green. Retain the previous installer and a data-compatible recovery path; never advise downgrading a migrated profile without compatibility verification.

After launch, make the fault suite mandatory for changes touching capture, device recovery, child-process ownership, Electron lifecycle, or recording controls. Repeat packaged audio-route acceptance for native capture/Electron upgrades and newly supported OS/device combinations. Review every shutdown escalation or unresolved capture result from voluntarily supplied reports. Each incident must yield a bounded reproduction and an invariant-level regression, not only a symptom-specific patch.

## Reviewable implementation slices

| Slice | Deliverable | Completion evidence |
| --- | --- | --- |
| A | Stop diagnostics and failing reproductions | Failure mechanism distinguishable without meeting content. |
| B | Bounded renderer/native stop and final-chunk handling | Fault tests pass; release acknowledged; capture tail verified. |
| C | Lifecycle ownership, races, probes, and truthful UI | Entry-point and concurrency matrix passes. |
| D | Packaged route/playback acceptance and RC gate | Recorded artifact/version, device matrix, timing, soak and trial results. |
| E | Source-specific automatic departure improvements | Separate adapter acceptance and truthful supported-feature claims. |

Order: A → B → C → D for the reported incident. E builds on B/C and can be promoted independently only when its own acceptance passes. Instrumentation and tests travel with the fixes. At implementation time, record an accepted decision extending the 2026-09-09 deadline-bound cleanup decision to capture-resource release; distinguish it from that decision's existing live-transcription worker deadlines.

This plan does not promise that bugs can never recur. It establishes a measurable stop contract, ownership boundaries, reproducible failure tests, and packaged release evidence that make recurrence less likely and diagnosable when it occurs.
