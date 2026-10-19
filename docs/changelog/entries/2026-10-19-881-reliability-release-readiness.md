### Reliability release acceptance

- **Issue:** Release acceptance for PR #881.
- **PR:** [#881](https://github.com/metagrover/pluto/pull/881)
- **Changed:** Keep completion synchronized for identically worded tasks using recorded owner and evidence, and retain explicit settled choices in structured meeting decisions.
- **Why:** Ambiguous text matching could disconnect saved completion state from notes, while an explicit choice could appear only in discussion prose.
- **Replaced:** Text-only duplicate matching and incomplete compact-writer decision guidance. Unknown task identity still fails closed.
- **Notes:** Add a production-provider path to the opt-in semantic acceptance suite and keep the cache regression bounded without raising model or test deadlines. This change does not publish a release.
