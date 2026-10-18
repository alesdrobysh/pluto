# Releasing Pluto

Product changes and release metadata go through PRs into `master`. GitHub requires
`Biome Lint` and `Full Tests` on an up-to-date PR before merging. Full Tests runs
TypeScript, release/installer regression tests, and the complete Vitest suite on
Apple Silicon macOS. Pushing or merging to `master` never publishes a release.

## Prepare, verify, publish

From a clean checkout of the GitHub default branch (`master`), synced with
`origin/master`:

```sh
pnpm release --dry-run
pnpm release
```

The second command prepares the next version and `docs/releases/v<version>.md`
on a `codex/release-*` branch, pushes that branch, and opens a metadata PR. It
creates no tag and publishes nothing. Review and merge the PR after its required
checks pass, then sync a clean `master` checkout and explicitly run:

```sh
pnpm release publish --dry-run
pnpm release publish
```

`publish` dispatches the Release workflow without a tag and waits for successful
installer verification at the exact current commit. Verification runs the full
test suite, builds native runtimes and an Apple Silicon DMG, mounts the DMG
read-only, checks the app inside it, and exercises empty-cache model preparation
plus a cached restart without additional downloads. This downloads about 1 GB
into disposable storage and never reads your profile or meeting data.

Only after verification passes does the command fetch again, confirm both the
checkout and remote `master` still identify that verified commit, and create and
push its annotated `v<SemVer>` tag. Failure or a changed revision blocks tagging.
The tag workflow independently requires successful untagged verification for
that SHA, repeats packaging checks, and publishes the installer and
`SHA256SUMS.txt`. The command waits for publication and reports the release URL.

Requires Node, pnpm, Git, and an authenticated GitHub CLI with repository Contents
write, Pull requests write, and Actions read/write access. Builds run on GitHub.
Never bypass required checks, force-push a release tag, or manually tag unverified
code. The default pipeline uses ad-hoc signing. A nonpublishing workflow dispatch with
`signed_validation=true` instead requires Developer ID signing and notarization,
then verifies Gatekeeper acceptance and the stapled ticket. It fails if signing
credentials are absent; it never falls back to an ad-hoc success. Configure
`MAC_CSC_LINK`, `MAC_CSC_KEY_PASSWORD`, `APPLE_ID`,
`APPLE_APP_SPECIFIC_PASSWORD`, and `APPLE_TEAM_ID` as repository secrets before
using this mode. A successful ad-hoc build does not satisfy signed validation.
Packaged recording, permissions, and real upgrades still require manual acceptance;
model preparation and automated tests do not establish those outcomes.

## Version policy and notes

- Default (`auto`): `1.0.0-rc.3` → `1.0.0-rc.4`; once stable, `1.0.0` → `1.0.1`.
- `pnpm release stable`: prepare promotion of the current RC base to stable.
- `pnpm release patch`, `minor`, or `major`: prepare an explicit stable bump.
- `pnpm release rc`: increment an RC, or start the next patch RC from stable.
- `pnpm release publish`: publish the version already merged into `package.json`;
  this does not bump it again.

New tags use SemVer; legacy dotted RC tags remain recognized. Automatic numbering
does not infer breaking changes. RCs are prereleases and never marked Latest.
Notes include non-merge commits since the nearest first-parent release tag, links,
and installation instructions. Supply `--notes /path/to/release-notes.md` when
preparing for a curated summary. Dry runs do not edit files, dispatch builds,
create PRs/tags, or publish.

## Publication and recovery

Publication creates a draft, uploads both the DMG and checksums, then publishes.
Retries resume a draft; an existing published immutable release is left intact.
API/authentication errors stop publication instead of being treated as absence.

- If preparation fails, inspect the checkout and existing branch/PR before retrying.
- If installer verification fails, no tag exists. Fix the source through a PR,
  merge it, sync `master`, and rerun `pnpm release publish`.
- If tag push fails, retry the printed push for that existing tag. Do not move it.
- If publication fails transiently, rerun the failed job with
  `gh run rerun <run-id> --failed`. Do not bump solely for a transient failure.
- If GitHub reports `tag_name was used by an immutable release`, that tag name is
  permanently reserved, even if the release was deleted. It cannot be recovered
  by deleting/recreating tags or disabling immutability. Prepare a fresh version
  only after release authorization; do not retry the reserved name. This applies
  to the failed rc.16 publication. This workflow change does not publish a replacement.
- A source change after tagging requires a new version; tags remain immutable.

Verify the command and publisher without publishing with
`pnpm run test:release-workflow`. A PR labelled `release-test` additionally builds
and verifies an installer without publishing. Untagged workflow dispatches also
never publish.

## One-command installation

`README.md` documents a private `gh api … | bash` command and the public
`curl … | bash` command for `scripts/install-macos.sh`. The installer uses the
public release list when available and falls back to authenticated GitHub CLI
while the repository is private. Public users need no GitHub account or CLI.
The repository and releases must actually be public before advertising the curl
command as available. Do not change repository visibility implicitly.

The installer selects the newest published release, including RCs, instead of
`/releases/latest`, which excludes RCs. Preserve the release asset names
`Pluto-Mac-<version>-Installer.dmg` and `SHA256SUMS.txt`. It verifies the checksum,
app identity/version, and signature before replacing an app, stages upgrades,
and restores the old app if replacement fails. It explicitly removes only
Pluto's quarantine attribute; profiles, models, and TCC permissions are untouched.
It refuses to upgrade a running app. This is an explicit trust workaround, not
Apple notarization. Do not use `xattr -cr` or disable Gatekeeper globally.

Run `pnpm run test:installer` for isolated installation and recovery checks.
`bash scripts/install-macos.sh --verify-only` downloads and verifies the live
release without installing, removing quarantine, or launching anything.
