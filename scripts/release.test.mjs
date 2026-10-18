import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { test } from 'node:test';
import { nextVersion, normalizeVersion, releaseNotes } from './release.mjs';

test('version policy handles RC, stable, explicit bumps, and legacy tags', () => {
  assert.equal(nextVersion('1.0.0-rc.3'), '1.0.0-rc.4');
  assert.equal(nextVersion('1.0.0'), '1.0.1');
  assert.equal(nextVersion('1.0.0-rc.3', 'stable'), '1.0.0');
  assert.equal(nextVersion('1.2.3', 'minor'), '1.3.0');
  assert.equal(nextVersion('1.2.3', 'major'), '2.0.0');
  assert.equal(nextVersion('1.2.3', 'rc'), '1.2.4-rc.1');
  assert.equal(nextVersion('1.2.3-rc.9', 'patch'), '1.2.4');
  assert.equal(normalizeVersion('v1.0.0.rc.3'), '1.0.0-rc.3');
  assert.throws(() => nextVersion('1.2.3', 'stable'));
  assert.throws(() => nextVersion('01.2.3'));
  assert.throws(() => nextVersion('1.2.3-beta.1'));
  assert.throws(() => nextVersion('1.2.3', 'unknown'));
});

test('release notes include direct changes, evidence links, and installation', () => {
  const notes = releaseNotes(
    '1.0.0-rc.4',
    'v1.0.0.rc.3',
    [{ hash: '1234567890', subject: 'Fix model cache reuse' }],
    'example/pluto',
  );
  assert.match(notes, /Release candidate for testing/);
  assert.match(notes, /Fix model cache reuse/);
  assert.match(notes, /example\/pluto\/commit\/1234567890/);
  assert.match(notes, /compare\/v1.0.0.rc.3\.\.\.v1.0.0-rc.4/);
  assert.match(notes, /SHA256SUMS.txt/);
  assert.match(notes, /not notarized/);
  assert.match(notes, /curl -fsSL/);
  assert.match(notes, /gh api/);
  assert.match(notes, /install-macos\.sh/);
  assert.doesNotMatch(notes, /xattr -cr|spctl --master-disable/);
});

test('CLI preview is read-only and blocks unsafe releases', () => {
  const root = mkdtempSync(resolve(tmpdir(), 'pluto-release-test-'));
  const script = resolve('scripts/release.mjs');
  const cwd = resolve(root, 'repo');
  const bin = resolve(root, 'bin');
  mkdirSync(cwd);
  mkdirSync(bin);
  writeFileSync(
    resolve(bin, 'gh'),
    '#!/bin/sh\nif [ "$1" = auth ]; then exit 0; fi\nif [ "$1" = api ]; then exit 1; fi\nprintf \'{"nameWithOwner":"example/pluto","defaultBranchRef":{"name":"master"}}\'\n',
    { mode: 0o755 },
  );
  const env = {
    ...process.env,
    PATH: `${bin}:${process.env.PATH}`,
    LEFTHOOK: '0',
  };
  const git = (...args) =>
    execFileSync('git', args, {
      cwd,
      env,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
  const preview = (...args) =>
    execFileSync(process.execPath, [script, ...args], {
      cwd,
      env,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  try {
    execFileSync('git', ['init', '--bare', resolve(root, 'origin.git')], {
      env,
      stdio: 'ignore',
    });
    git('init', '-b', 'master');
    git('config', 'user.name', 'Release Test');
    git('config', 'user.email', 'release-test@example.invalid');
    git('remote', 'add', 'origin', resolve(root, 'origin.git'));
    const pkg = '{"version":"1.0.0-rc.3"}\n';
    writeFileSync(resolve(cwd, 'package.json'), pkg);
    git('add', '.');
    git('commit', '-m', 'Initial release');
    git('tag', 'v1.0.0.rc.3');
    git('push', '-u', 'origin', 'master', '--tags');
    assert.throws(() => preview('--dry-run'), /No changes since/);
    assert.match(
      preview('stable', '--dry-run'),
      /to stable with no additional code changes/,
    );
    writeFileSync(resolve(cwd, 'fix.txt'), 'Neutral fixture\n');
    assert.throws(() => preview('--dry-run'), /clean checkout/);
    git('add', '.');
    git('commit', '-m', 'Fix restart cache reuse');
    assert.throws(() => preview('--dry-run'), /must match origin/);
    git('push', 'origin', 'master');
    const head = git('rev-parse', 'HEAD');
    const tags = git('tag', '--list');
    const output = preview('--dry-run');
    assert.match(output, /1.0.0-rc.3 → 1.0.0-rc.4/);
    assert.match(output, /Fix restart cache reuse/);
    assert.doesNotMatch(output, /Initial release/);
    assert.equal(git('rev-parse', 'HEAD'), head);
    assert.equal(git('tag', '--list'), tags);
    assert.equal(git('status', '--porcelain'), '');
    assert.equal(readFileSync(resolve(cwd, 'package.json'), 'utf8'), pkg);
    assert.throws(() => preview(), /Actions read access/);
    assert.equal(git('status', '--porcelain'), '');
    assert.equal(git('tag', '--list'), tags);
    git('tag', 'v1.0.0.rc.4');
    assert.throws(() => preview('--dry-run'), /already exists/);
    git('tag', '-d', 'v1.0.0.rc.4');
    git('switch', '-c', 'codex/fixture');
    assert.throws(() => preview('--dry-run'), /Release from master/);
    assert.throws(() => preview('--typo'), /Unknown argument/);
    // Exercise preparation and tagging against disposable local Git only.
    git('switch', 'master');
    const calls = resolve(root, 'calls');
    const watched = resolve(root, 'watched');
    const dispatched = resolve(root, 'dispatched');
    writeFileSync(
      resolve(bin, 'gh'),
      `#!/bin/sh
printf '%s\\n' "$*" >> '${calls}'
case "$1 $2" in
  "auth status") exit 0 ;;
  "repo view") printf '{"nameWithOwner":"example/pluto","defaultBranchRef":{"name":"master"}}' ;;
  "api "*) printf active ;;
  "pr create") printf 'https://github.com/example/pluto/pull/42' ;;
  "workflow run") touch '${dispatched}' ;;
  "release view") printf 'https://github.com/example/pluto/releases/tag/v1.0.0-rc.4' ;;
  "run list") if echo "$*" | grep -q -- '--event push'; then printf '[{"databaseId":43,"headBranch":"v1.0.0-rc.4"}]'; elif [ -f '${dispatched}' ]; then printf '[{"databaseId":42}]'; else printf '[]'; fi ;;
  "run watch") touch '${watched}'; if [ -f '${root}/change-checkout' ]; then git checkout --detach HEAD^; fi; if [ -f '${root}/fail-verification' ]; then exit 1; fi ;;
  *) exit 1 ;;
esac
`,
      { mode: 0o755 },
    );
    writeFileSync(resolve(bin, 'pnpm'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
    assert.match(preview(), /pull\/42/);
    assert.equal(git('tag', '--list'), tags);
    assert.match(
      git('branch', '--show-current'),
      /^codex\/release-v1\.0\.0-rc\.4-/,
    );
    const prepared = git('rev-parse', 'HEAD');
    assert.equal(
      JSON.parse(readFileSync(resolve(cwd, 'package.json'), 'utf8')).version,
      '1.0.0-rc.4',
    );
    assert.equal(git('rev-parse', 'origin/master'), head);
    // Simulate the PR being merged and the default branch synced.
    git('switch', 'master');
    git('merge', '--ff-only', prepared);
    git('push', 'origin', 'master');
    assert.match(preview('publish', '--dry-run'), /Verify installer/);
    assert.equal(existsSync(dispatched), false);
    writeFileSync(resolve(root, 'fail-verification'), '');
    assert.throws(() => preview('publish'));
    assert.equal(git('tag', '--list'), tags);
    assert.equal(git('rev-parse', 'HEAD'), prepared);
    rmSync(resolve(root, 'fail-verification'));
    rmSync(dispatched);
    writeFileSync(resolve(root, 'change-checkout'), '');
    assert.throws(() => preview('publish'), /changed during verification/);
    assert.equal(git('tag', '--list'), tags);
    rmSync(resolve(root, 'change-checkout'));
    git('switch', 'master');
    rmSync(dispatched);
    assert.match(preview('publish'), /Tag v1.0.0-rc.4 pushed/);
    assert.equal(git('rev-parse', 'v1.0.0-rc.4^{}'), prepared);
    assert.equal(git('rev-parse', 'origin/master'), prepared);
    assert.equal(git('status', '--porcelain'), '');
    assert.equal(existsSync(watched), true);
    const operations = readFileSync(calls, 'utf8');
    assert.match(
      operations,
      /workflow run release.yml --ref master -f expected_sha=/,
    );
    assert.match(operations, /run watch 42 --exit-status/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('signed CI validation fails closed without credentials and cannot publish', () => {
  const workflow = readFileSync(
    resolve('.github/workflows/release.yml'),
    'utf8',
  );
  const step = workflow
    .split(
      '      - name: Require signing credentials for signed validation\n',
    )[1]
    .split('      - name: ')[0];
  const script = step
    .split('        run: |\n')[1]
    .split('\n')
    .map((line) => line.slice(10))
    .join('\n');
  const keys = [
    'CSC_LINK',
    'CSC_KEY_PASSWORD',
    'APPLE_ID',
    'APPLE_APP_SPECIFIC_PASSWORD',
    'APPLE_TEAM_ID',
  ];
  const empty = {
    ...process.env,
    ...Object.fromEntries(keys.map((key) => [key, ''])),
  };
  empty.BASH_ENV = undefined;
  const absent = spawnSync(
    '/bin/bash',
    ['--noprofile', '--norc', '-c', script],
    {
      env: empty,
      encoding: 'utf8',
    },
  );
  assert.equal(absent.status, 1);
  assert.ok(
    absent.stderr.includes('Missing required signing credential: CSC_LINK'),
  );
  const provided = Object.fromEntries(
    keys.map((key) => [key, 'fictional-secret']),
  );
  const accepted = spawnSync(
    '/bin/bash',
    ['--noprofile', '--norc', '-c', script],
    {
      env: { ...empty, ...provided },
      encoding: 'utf8',
    },
  );
  assert.equal(accepted.status, 0);
  assert.equal(accepted.stdout + accepted.stderr, '');
  for (const key of keys) {
    const missingOne = spawnSync(
      '/bin/bash',
      ['--noprofile', '--norc', '-c', script],
      {
        env: { ...empty, ...provided, [key]: '' },
        encoding: 'utf8',
      },
    );
    assert.equal(missingOne.status, 1);
    assert.ok(missingOne.stderr.includes(key));
    assert.ok(!missingOne.stderr.includes('fictional-secret'));
  }
  assert.ok(
    workflow.includes(
      '--publish never --config.forceCodeSigning=true --config.mac.hardenedRuntime=true --config.mac.notarize=true',
    ),
  );
  assert.ok(
    workflow.includes('spctl --assess --type execute --verbose=2 "$APP"'),
  );
  assert.ok(workflow.includes('xcrun stapler validate "$APP"'));
  assert.ok(
    workflow.includes(
      "if: github.event_name == 'push' && startsWith(github.ref, 'refs/tags/')",
    ),
  );
});

test('unsigned CI packaging removes empty signing variables before electron-builder', () => {
  const workflow = readFileSync(
    resolve('.github/workflows/release.yml'),
    'utf8',
  );
  const step = workflow
    .split('      - name: Build and Package DMG\n')[1]
    .split('      - name: ')[0];
  const script = step
    .split('        run: |\n')[1]
    .split('\n')
    .map((line) => line.slice(10))
    .join('\n');
  const bin = mkdtempSync(resolve(tmpdir(), 'pluto-unsigned-gate-'));
  try {
    writeFileSync(
      resolve(bin, 'pnpm'),
      '#!/bin/sh\nif [ "$2" = electron-builder ]; then\n  for NAME in CSC_LINK CSC_KEY_PASSWORD APPLE_ID APPLE_APP_SPECIFIC_PASSWORD APPLE_TEAM_ID; do\n    env | cut -d= -f1 | grep -F -x "$NAME" >/dev/null && exit 63\n  done\nfi\nexit 0\n',
      { mode: 0o755 },
    );
    const result = spawnSync(
      '/bin/bash',
      ['--noprofile', '--norc', '-c', script],
      {
        encoding: 'utf8',
        env: {
          ...process.env,
          BASH_ENV: undefined,
          PATH: `${bin}:${process.env.PATH}`,
          SIGNED_VALIDATION: 'false',
          CSC_LINK: '',
          CSC_KEY_PASSWORD: '',
          APPLE_ID: '',
          APPLE_APP_SPECIFIC_PASSWORD: '',
          APPLE_TEAM_ID: '',
        },
      },
    );
    assert.equal(result.status, 0, result.stderr);
  } finally {
    rmSync(bin, { recursive: true, force: true });
  }
});
