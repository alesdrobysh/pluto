import fs from 'node:fs';
import path from 'node:path';

export const PLUTO_PRODUCT_NAME = 'Pluto';
export const PLUTO_BUNDLE_IDENTIFIER = 'com.pluto.app';

export type SourceProfileMode = 'dev' | 'start';

export const resolveSourceUserDataDir = ({
  explicit,
  tempDir,
  productionDir,
  mode,
}: {
  explicit?: string;
  tempDir: string;
  productionDir?: string;
  mode: SourceProfileMode;
}): string => {
  const selected = explicit?.trim();
  const userDataDir =
    selected ||
    (productionDir
      ? mode === 'start'
        ? productionDir
        : `${productionDir}-development`
      : undefined) ||
    path.join(tempDir, 'pluto-development-profile');
  if (
    mode === 'dev' &&
    productionDir &&
    isSameUserDataDir(userDataDir, productionDir)
  ) {
    throw new Error('pnpm dev cannot open the production data profile.');
  }
  return userDataDir;
};

const isSameUserDataDir = (left: string, right: string): boolean => {
  const canonical = (value: string) => {
    const absolute = path.resolve(value);
    try {
      return fs.realpathSync.native(absolute).toLowerCase();
    } catch {
      return absolute.toLowerCase();
    }
  };
  return canonical(left) === canonical(right);
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

export const resolveSourceProfileMode = (argv: string[]): SourceProfileMode => {
  const prefix = '--pluto-source-mode=';
  const value = argv.find((argument) => argument.startsWith(prefix));
  if (value && value !== `${prefix}start` && value !== `${prefix}dev`) {
    throw new Error('Invalid source profile mode.');
  }
  return value === `${prefix}start` ? 'start' : 'dev';
};
