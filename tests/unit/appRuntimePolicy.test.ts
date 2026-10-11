import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  canOpenProductionDatabase,
  resolveProductionUserDataDir,
  resolveSourceUserDataDir,
  resolveUserDataArgument,
} from '../../electron/appRuntimePolicy';

describe('Pluto application runtime policy', () => {
  it('routes all source commands to a persistent isolated profile', () => {
    const productionDir = resolveProductionUserDataDir({
      platform: 'darwin',
      homeDir: '/Users/pluto',
    });
    expect(productionDir).toBe(
      '/Users/pluto/Library/Application Support/pluto',
    );
    expect(
      resolveSourceUserDataDir({
        tempDir: '/tmp',
        productionDir: productionDir!,
      }),
    ).toBe(`${productionDir}-development`);
    expect(
      resolveSourceUserDataDir({
        tempDir: '/tmp',
        productionDir: productionDir!,
      }),
    ).toBe(`${productionDir}-development`);
  });
  it('honors explicit isolated profiles but keeps dev out of production', () => {
    const productionDir = '/Users/pluto/Library/Application Support/pluto';
    for (const explicit of [
      '/tmp/pluto-development-profile',
      '/tmp/pluto-test-profile',
    ]) {
      expect(
        resolveSourceUserDataDir({
          explicit,
          tempDir: '/private/tmp',
          productionDir,
        }),
      ).toBe(explicit);
    }
    expect(
      resolveSourceUserDataDir({
        explicit: '  ',
        tempDir: '/tmp',
        productionDir,
      }),
    ).toBe(`${productionDir}-development`);
    for (const explicit of [
      productionDir,
      `${productionDir}/../PLUTO`,
      `${productionDir}/nested-profile`,
    ]) {
      expect(() =>
        resolveSourceUserDataDir({
          explicit,
          tempDir: '/tmp',
          productionDir,
        }),
      ).toThrow('Source Pluto cannot open the production data profile.');
    }
  });
  it('rejects a symlink to the production profile', () => {
    const root = fs.mkdtempSync(
      path.join(os.tmpdir(), 'pluto-profile-policy-'),
    );
    try {
      const productionDir = path.join(root, 'pluto');
      const alias = path.join(root, 'alias');
      fs.mkdirSync(productionDir);
      fs.symlinkSync(productionDir, alias, 'dir');
      expect(() =>
        resolveSourceUserDataDir({
          explicit: alias,
          tempDir: root,
          productionDir,
        }),
      ).toThrow('Source Pluto cannot open the production data profile.');
      expect(() =>
        resolveSourceUserDataDir({
          explicit: path.join(alias, 'not-created'),
          tempDir: root,
          productionDir,
        }),
      ).toThrow('Source Pluto cannot open the production data profile.');
      const nested = path.join(productionDir, 'nested');
      fs.mkdirSync(nested);
      const nestedAlias = path.join(root, 'nested-alias');
      fs.symlinkSync(nested, nestedAlias, 'dir');
      expect(() =>
        resolveSourceUserDataDir({
          explicit: `${nestedAlias}/..`,
          tempDir: root,
          productionDir,
        }),
      ).toThrow('Source Pluto cannot open the production data profile.');
      fs.symlinkSync(productionDir, `${productionDir}-development`, 'dir');
      expect(() =>
        resolveSourceUserDataDir({
          tempDir: root,
          productionDir,
        }),
      ).toThrow('Source Pluto cannot open the production data profile.');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
  it('rejects relative overrides before a profile can be opened', () => {
    expect(() =>
      resolveSourceUserDataDir({
        explicit: 'relative/profile',
        tempDir: '/tmp',
      }),
    ).toThrow('absolute user-data directory');
  });
  it('keeps the fallback path for unsupported platforms', () => {
    expect(
      resolveProductionUserDataDir({
        platform: 'linux',
        homeDir: '/home/pluto',
      }),
    ).toBeNull();
    expect(resolveSourceUserDataDir({ tempDir: '/private/tmp' })).toBe(
      path.join('/private/tmp', 'pluto-development-profile'),
    );
  });
  it('allows normal source startup without a signed app and preserves packaged enforcement', () => {
    expect(
      canOpenProductionDatabase({ isPackaged: false, signedBuildValid: false }),
    ).toBe(true);
    expect(
      canOpenProductionDatabase({ isPackaged: true, signedBuildValid: false }),
    ).toBe(false);
    expect(
      canOpenProductionDatabase({ isPackaged: true, signedBuildValid: true }),
    ).toBe(true);
    expect(
      canOpenProductionDatabase({
        isPackaged: true,
        signedBuildValid: false,
        allowUnsignedPackaged: true,
      }),
    ).toBe(true);
  });
  it('reads the exact selected profile passed to Electron', () => {
    expect(
      resolveUserDataArgument([
        '/Applications/Electron',
        '.',
        '--user-data-dir=/tmp/pluto-test-profile',
      ]),
    ).toBe('/tmp/pluto-test-profile');
    expect(resolveUserDataArgument(['/Applications/Electron'])).toBeNull();
  });
});
