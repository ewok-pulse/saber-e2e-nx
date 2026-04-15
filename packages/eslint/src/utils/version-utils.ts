import { getDependencyVersionFromPackageJson, type Tree } from '@nx/devkit';
import { checkAndCleanWithSemver } from '@nx/devkit/src/utils/semver';
import { readModulePackageJson } from 'nx/src/devkit-internals';
import { coerce } from 'semver';
import {
  backwardCompatibleVersions,
  type PackageCompatVersions,
  type PackageVersionNames,
} from './backward-compatible-versions';
import * as latestVersions from './versions';

export function getInstalledPackageVersion(
  pkgName: string,
  tree?: Tree
): string | null {
  // When a tree is provided, look up the dependency from the tree's
  // package.json so that generators react to the version the user has
  // declared for the workspace they are running against, rather than the
  // version in the CLI's own node_modules. This matches the `@nx/angular`
  // detection pattern and makes the default (when nothing is installed)
  // fall back to `latestVersions` rather than to whatever happens to be
  // resolved on disk.
  if (tree) {
    const declared = getDependencyVersionFromPackageJson(tree, pkgName);
    if (!declared) {
      return null;
    }
    try {
      return checkAndCleanWithSemver(tree, pkgName, declared);
    } catch {}
    return null;
  }

  try {
    const packageJson = readModulePackageJson(pkgName).packageJson;
    return packageJson.version;
  } catch {}

  const declaredFromFs = getDependencyVersionFromPackageJson(pkgName);
  if (!declaredFromFs) {
    return null;
  }
  try {
    return checkAndCleanWithSemver(pkgName, declaredFromFs);
  } catch {}
  return null;
}

export function getInstalledEslintVersion(tree?: Tree): string | null {
  return getInstalledPackageVersion('eslint', tree);
}

export function getInstalledEslintVersionInfo(
  tree?: Tree
): { version: string; major: number } | null {
  const installed = getInstalledEslintVersion(tree);
  if (!installed) {
    return null;
  }
  const coerced = coerce(installed);
  if (!coerced) {
    return null;
  }
  return { version: coerced.version, major: coerced.major };
}

export function getInstalledEslintMajorVersion(tree?: Tree): number | null {
  return getInstalledEslintVersionInfo(tree)?.major ?? null;
}

/**
 * Returns a single version pin for the given package, compatible with the
 * given ESLint major version. Falls back to the latest pin when the major is
 * unknown (e.g., a future ESLint major we haven't explicitly added support
 * for yet).
 */
export function getPkgVersionForEslintMajor(
  pkgVersionName: PackageVersionNames,
  eslintMajorVersion: number
): string {
  return (
    backwardCompatibleVersions[eslintMajorVersion]?.[pkgVersionName] ??
    latestVersions[pkgVersionName]
  );
}

/**
 * Returns the full set of package version pins compatible with the ESLint
 * major version installed in the tree. When no ESLint is installed, returns
 * the latest pins (the default for new workspaces). An installed major that
 * is newer than anything we explicitly support also falls back to latest, so
 * new ESLint majors must be added to `backwardCompatibleVersions` when they
 * become the default.
 */
export function versions(tree: Tree): PackageCompatVersions {
  const majorEslintVersion = getInstalledEslintMajorVersion(tree);
  return (
    (majorEslintVersion != null &&
      backwardCompatibleVersions[majorEslintVersion]) ||
    latestVersions
  );
}
