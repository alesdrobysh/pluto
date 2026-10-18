import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { prepareDevElectron } from '../../scripts/prepareDevElectron';

describe.skipIf(process.platform !== 'darwin')(
  'development permission bundle',
  () => {
    it('creates a signed source app with purpose strings for all requested permissions', () => {
      const entry = prepareDevElectron();
      const executable = JSON.parse(
        readFileSync(entry, 'utf8')
          .replace('export default ', '')
          .trim()
          .replace(/;$/, ''),
      );
      const bundle = path.resolve(executable, '../../..');
      const plist = path.join(bundle, 'Contents/Info.plist');
      for (const [key, value] of Object.entries({
        CFBundleName: 'Pluto Development',
        CFBundleDisplayName: 'Pluto Development',
        CFBundleIdentifier: 'com.pluto.app.development',
      })) {
        expect(
          execFileSync('plutil', ['-extract', key, 'raw', '-o', '-', plist], {
            encoding: 'utf8',
          }).trim(),
        ).toBe(value);
      }
      for (const key of [
        'NSMicrophoneUsageDescription',
        'NSAudioCaptureUsageDescription',
        'NSCalendarsFullAccessUsageDescription',
        'NSCalendarsUsageDescription',
      ]) {
        expect(
          execFileSync('plutil', ['-extract', key, 'raw', '-o', '-', plist], {
            encoding: 'utf8',
          }).trim(),
        ).toContain('Pluto');
      }
      expect(() =>
        execFileSync('codesign', ['--verify', '--deep', '--strict', bundle]),
      ).not.toThrow();
      const entitlements = execFileSync(
        'codesign',
        ['--display', '--entitlements', ':-', bundle],
        { encoding: 'utf8' },
      );
      expect(entitlements).toContain('com.apple.security.device.audio-input');
      expect(prepareDevElectron()).toBe(entry);
    }, 60_000);
  },
);
