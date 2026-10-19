### Reliability release acceptance

- **Issue:** Release acceptance for PR #881.
- **PR:** [#881](https://github.com/metagrover/pluto/pull/881)
- **Changed:** Keep completion synchronized for identically worded tasks using recorded owner and evidence, retain explicit settled choices and personal experiences without invented pronouns, and let existing source review repair a disputed conditional action before it is eligible for publication.
- **Why:** Ambiguous text matching could disconnect saved completion state from notes, while an explicit choice could appear only in discussion prose.
- **Replaced:** Text-only duplicate matching and incomplete compact-writer decision guidance. Unknown task identity still fails closed.
- **Notes:** Recheck conditions and cancellations after semantic repair; failed or unavailable review leaves disputed work outside active commitments. Add a production-provider path to the opt-in semantic acceptance suite and keep the cache regression bounded without raising model or test deadlines. This change does not publish a release.

- **Live acceptance follow-up:** Preserve a full cited utterance once when reviewed note points collapse to identical prose, so a repeated paraphrase cannot hide another source clause. Measure Ask Pluto answer timing from the answer request rather than the earlier scope probe. Clarify that a call ending while its app stays open can require manual recording stop.
