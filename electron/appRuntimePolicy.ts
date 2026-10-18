import fs from 'node:fs';
import path from 'node:path';

export const PLUTO_PRODUCT_NAME = 'Pluto';
export const PLUTO_BUNDLE_IDENTIFIER = 'com.pluto.app';

export const PLUTO_DEVELOPMENT_PRODUCT_NAME = 'Pluto Development';
export const PLUTO_DEVELOPMENT_BUNDLE_IDENTIFIER = 'com.pluto.app.development';

export const resolveSourceUserDataDir = ({
  explicit,
  tempDir,
  productionDir,
}: {
  explicit?: string;
  tempDir: string;
  productionDir?: string;
}): string => {
  const selected = explicit?.trim();
  if (selected && !path.isAbsolute(selected)) {
    throw new Error('Source profiles require an absolute user-data directory.');
  }
  const userDataDir =
    selected ||
    (productionDir ? `${productionDir}-development` : undefined) ||
    path.join(tempDir, 'pluto-development-profile');
  if (productionDir && isWithinUserDataDir(userDataDir, productionDir)) {
    throw new Error('Source Pluto cannot open the production data profile.');
  }
  return userDataDir;
};

const isWithinUserDataDir = (left: string, right: string): boolean => {
  const canonical = (value: string) => {
    const absolute = value;
    let existing = absolute;
    while (!fs.existsSync(existing) && path.dirname(existing) !== existing) {
      existing = path.dirname(existing);
    }
    const resolved = fs.realpathSync.native(existing);
    return path
      .resolve(resolved, path.relative(existing, absolute))
      .toLowerCase();
  };
  const relative = path.relative(canonical(right), canonical(left));
  return (
    relative === '' ||
    (!relative.startsWith(`..${path.sep}`) &&
      relative !== '..' &&
      !path.isAbsolute(relative))
  );
};

export const resolveProductionUserDataDir = (input: {
  platform: string;
  homeDir: string;
}): string | null =>
  input.platform === 'darwin'
    ? path.join(input.homeDir, 'Library', 'Application Support', 'pluto')
    : null;

export const canOpenProductionDatabase = (input: {
  isPackaged: boolean;
  signedBuildValid: boolean;
  allowUnsignedPackaged?: boolean;
}): boolean =>
  !input.isPackaged ||
  input.signedBuildValid ||
  Boolean(input.allowUnsignedPackaged);

export const resolveUserDataArgument = (argv: string[]): string | null => {
  const prefix = '--user-data-dir=';
  const value = argv.find((argument) => argument.startsWith(prefix));
  const resolved = value?.slice(prefix.length).trim();
  return resolved || null;
};
