import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

if (process.platform !== 'darwin') process.exit(0);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const electronVersion = require('electron/package.json').version;
const arch = process.env.npm_config_arch ?? process.arch;
if (!['arm64', 'x64'].includes(arch))
  throw new Error(`Unsupported notification bridge architecture: ${arch}`);
const source = path.join(root, 'native/notifications/notification_bridge.mm');
const output = path.join(root, 'resources/bin/notification-bridge.node');
const stamp = `${output}.build.json`;
const fingerprint = createHash('sha256')
  .update(readFileSync(source))
  .update(readFileSync(fileURLToPath(import.meta.url)))
  .update(`${electronVersion}:${arch}`)
  .digest('hex');
if (
  process.argv.includes('--ensure') &&
  existsSync(output) &&
  existsSync(stamp) &&
  JSON.parse(readFileSync(stamp, 'utf8')).fingerprint === fingerprint
) {
  try {
    execFileSync('codesign', ['--verify', '--strict', output], {
      stdio: 'pipe',
    });
    console.log('Notification bridge is current.');
    process.exit(0);
  } catch {}
}
const cacheRoots = [
  process.env.npm_config_devdir,
  path.join(os.homedir(), '.electron-gyp'),
  path.join(os.homedir(), '.cache/electron-gyp'),
].filter(Boolean);
let headers = cacheRoots
  .map((directory) => path.join(directory, electronVersion, 'include/node'))
  .find((directory) => existsSync(path.join(directory, 'node_api.h')));
if (!headers) {
  const cache = path.join(
    os.homedir(),
    '.cache/pluto-electron-headers',
    electronVersion,
  );
  headers = path.join(cache, `node-v${electronVersion}`, 'include/node');
  if (!existsSync(path.join(headers, 'node_api.h'))) {
    mkdirSync(cache, { recursive: true });
    const filename = `node-v${electronVersion}-headers.tar.gz`;
    const base = `https://artifacts.electronjs.org/headers/dist/v${electronVersion}`;
    const [archiveResponse, sumsResponse] = await Promise.all([
      fetch(`${base}/${filename}`),
      fetch(`${base}/SHASUMS256.txt`),
    ]);
    if (!archiveResponse.ok || !sumsResponse.ok)
      throw new Error('Could not fetch Electron notification bridge headers.');
    const archive = Buffer.from(await archiveResponse.arrayBuffer());
    const expected = (await sumsResponse.text())
      .split('\n')
      .find((line) => line.trim().endsWith(filename))
      ?.split(/\s+/)[0];
    if (
      !expected ||
      createHash('sha256').update(archive).digest('hex') !== expected
    )
      throw new Error('Electron headers checksum mismatch.');
    const archivePath = path.join(cache, filename);
    writeFileSync(archivePath, archive);
    try {
      execFileSync('tar', ['-xzf', archivePath, '-C', cache]);
    } finally {
      rmSync(archivePath, { force: true });
    }
  }
}
mkdirSync(path.dirname(output), { recursive: true });
const temporary = `${output}.${process.pid}.tmp`;
try {
  execFileSync(
    'xcrun',
    [
      'clang++',
      '-std=c++17',
      '-fobjc-arc',
      '-fblocks',
      '-mmacosx-version-min=12.0',
      '-arch',
      arch === 'x64' ? 'x86_64' : arch,
      '-bundle',
      '-undefined',
      'dynamic_lookup',
      '-I',
      headers,
      '-framework',
      'Foundation',
      '-framework',
      'UserNotifications',
      source,
      '-o',
      temporary,
    ],
    { stdio: 'inherit' },
  );
  execFileSync('codesign', ['--sign', '-', '--force', temporary], {
    stdio: 'inherit',
  });
  renameSync(temporary, output);
  writeFileSync(
    stamp,
    `${JSON.stringify({ fingerprint, electronVersion, arch })}\n`,
  );
} finally {
  rmSync(temporary, { force: true });
}
console.log(`Built macOS notification bridge (${arch}).`);
