# Improvements preserved from the MTP investigation

This change extracts independently useful fixes from `codex/chatgpt-mtp-integration`
(at `0dead4a09`) on top of the ChatGPT integration in PR #880. It does not enable
MTP, change local model defaults, migrate model selections, or introduce a native
inference runtime. The source branch remains available for the work not included.

## Included

| Area | Preserved behavior |
| --- | --- |
| Final transcription | Refresh the open meeting as well as the meeting list after final transcription; handle a failed detail refresh without losing the completed result. |
| Interrupted recordings | Persist recoverable audio before repair transcription starts, including encrypted journal recovery; retain user edits made while recovery runs. |
| Shutdown | Let the native quit event unwind before retrying Electron termination. |
| Commitment identity | Match saved action state to its task and evidence instead of inheriting state from a reordered list position; unreadable edits cannot clear a completion decision. |
| Secondary extraction | Keep the canonical meeting actions and their reviewed lifecycle while updating other extracted entities. |
| Background synthesis | Link existing source-backed obligations instead of manufacturing a second task; respect edited and completed source actions. |
| Dashboard, reminders, and briefings | Exclude cancelled or retired obligations and keep personal responsibilities grounded in structured owner evidence or explicit user adoption. |
| Ask Pluto | Preserve assignee scope across follow-ups instead of rerouting the question into general workspace priorities. |
| Ollama readiness | Check service and installed model metadata without loading or downloading a model; explain recovery options in setup and settings. |
| Provider recovery | Retry failed provider initialization after the service returns, persist actionable startup failures, and show the actual selected model in diagnostics. |

Existing Ollama general and quick defaults remain `gemma4:12b` and
`phi4-mini:3.8b`. Both custom overrides remain independent. The ChatGPT sign-in,
provider-switch cancellation, request coalescing, durable accounting, and usage
limits from PR #880 remain in place.

Personal ownership is not inferred from prose such as “I will” or a name at the
start of a task. The extracted ownership filter uses saved owner fields, explicit
user-created or adopted tasks, and source-linked assignee metadata. Ambiguous
ownership stays out of personal reminders.

Release acceptance additionally disambiguates identically worded tasks by recorded
owner and evidence. Existing source review can repair disputed conditions before
promotion; missing withdrawal context and unsupported personal references retain
attributed source speech. Complete literal policies keep their source wording.
These changes retain the existing model, context, request and deadline limits.

## Already preserved in PR #880

The ChatGPT integration already includes its earlier owner/deadline corrections,
single-meeting semantic scope, bounded usage, duplicate-request prevention,
historical note reuse, and the simplified connection experience. They do not
need to be reintroduced from the integration branch.

## Deliberately not included

- MTP model defaults, setup/version gates, automatic model migrations, residency
  tuning, native runners, or performance promotion. The memory and quality gates
  were not met.
- The later experimental notes-review protocol, larger review budgets, and MTP prompt
  variants. Those need an independent provider-specific quality and usage review;
  passing schema or unit tests does not establish note quality.
- New prose-pattern completion, decision, or ownership classifiers. These do not
  meet the requested structured-evidence approach.
- Developer ID signing or notarization workflow changes. Pluto retains its
  existing verified installer workflow and this PR does not publish a release.
- Private meeting artifacts, account credentials, or benchmark responses. They
  remain outside the repository and are not included in shared fixtures.

The extracted code is checked with focused regressions and the full suite. Any
remaining packaged acceptance or CI results are recorded in the pull request;
this inventory is not itself a release-readiness claim.
