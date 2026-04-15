import type { Tree } from '@nx/devkit';
import { getInstalledEslintMajorVersion } from '@nx/eslint/src/utils/version-utils';
import {
  backwardCompatibleVersions,
  type PackageCompatVersions,
} from './backward-compatible-versions';

/**
 * Returns Vue lint package pins compatible with the ESLint major installed
 * in the tree. Falls back to the latest pins (keyed by the latest supported
 * ESLint major) when no ESLint is installed or the installed major isn't
 * explicitly supported yet.
 */
export function versions(tree: Tree): PackageCompatVersions {
  const majorEslintVersion = getInstalledEslintMajorVersion(tree);
  return (
    (majorEslintVersion != null &&
      backwardCompatibleVersions[majorEslintVersion]) ||
    backwardCompatibleVersions[10]
  );
}
