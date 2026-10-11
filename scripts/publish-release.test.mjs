import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';

const publisher = resolve('scripts/publish-release.sh');
for (const state of [
  'missing',
  'draft',
  'published',
  'lookup-error',
  'reserved',
  'upload-error',
  'stable',
  'legacy',
]) {
  test(`publisher handles ${state} without unsafe publication`, () => {
    const root = mkdtempSync(join(tmpdir(), 'pluto-publisher-'));
    try {
      const bin = join(root, 'bin');
      const assets = join(root, 'assets');
      const calls = join(root, 'calls');
      mkdirSync(bin);
      mkdirSync(assets);
      writeFileSync(
        join(assets, 'Pluto-Mac-1.0.0-rc.17-Installer.dmg'),
        'fictional installer',
      );
      writeFileSync(join(assets, 'SHA256SUMS.txt'), 'fictional checksum');
      if (state !== 'legacy')
        writeFileSync(
          join(assets, 'release-notes.md'),
          'Fictional release notes',
        );
      writeFileSync(
        join(bin, 'gh'),
        `#!/bin/sh
printf '%s\\n' "$*" >> "$CALLS"
case "$1 $2" in
  "api "*)
    case "$STATE" in
      lookup-error) echo 'HTTP 403' >&2; exit 1 ;;
      draft) printf true ;;
      published) printf false ;;
    esac ;;
  "release create") if [ "$STATE" = reserved ]; then echo 'tag_name was used by an immutable release' >&2; exit 1; fi ;;
  "release upload") if [ "$STATE" = upload-error ]; then exit 1; fi ;;
esac
`,
        { mode: 0o755 },
      );
      const result = spawnSync(
        'bash',
        [publisher, state === 'stable' ? 'v1.0.0' : 'v1.0.0-rc.17', assets],
        {
          env: {
            ...process.env,
            PATH: `${bin}:${process.env.PATH}`,
            GH_REPO: 'example/pluto',
            STATE: state,
            CALLS: calls,
          },
          encoding: 'utf8',
        },
      );
      const operations = readFileSync(calls, 'utf8');
      assert.doesNotMatch(operations, /release delete|tag delete/);
      if (['lookup-error', 'reserved', 'upload-error'].includes(state)) {
        assert.notEqual(result.status, 0);
        assert.doesNotMatch(operations, /release edit/);
        if (state === 'lookup-error')
          assert.doesNotMatch(operations, /release create|release upload/);
        if (state === 'reserved') {
          assert.match(result.stderr, /permanently reserved/);
          assert.doesNotMatch(operations, /release upload/);
        }
      } else {
        assert.equal(result.status, 0, result.stderr);
        if (state === 'published') {
          assert.doesNotMatch(
            operations,
            /release create|release upload|release edit/,
          );
        } else {
          if (['missing', 'stable', 'legacy'].includes(state)) {
            assert.match(operations, /release create .* --draft --verify-tag/);
            assert.ok(
              operations.indexOf('release create') <
                operations.indexOf('release upload'),
            );
          } else assert.doesNotMatch(operations, /release create/);
          assert.ok(
            operations.indexOf('release upload') <
              operations.indexOf('release edit'),
          );
          assert.match(operations, /release edit .* --draft=false/);
          if (state === 'stable')
            assert.match(operations, /--prerelease=false/);
          else assert.match(operations, /--prerelease --latest=false/);
          if (state === 'legacy') {
            assert.match(operations, /release create .* --generate-notes/);
            assert.doesNotMatch(operations, /release edit .* --generate-notes/);
          }
        }
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
}
