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
 * major version installed in the tree.
 *
 * When ESLint is already installed, the pins are keyed on its major. An
 * installed major that is newer than anything we explicitly support falls
 * back to `latestVersions`, so new ESLint majors must be added to
 * `backwardCompatibleVersions` when they become the default.
 *
 * When no ESLint is installed, the default is `latestVersions` — unless
 * the user has explicitly opted into legacy eslintrc via
 * `ESLINT_USE_FLAT_CONFIG=false`, in which case we return the v8 compat
 * map (the last major that supported eslintrc natively). Without this
 * check we'd install an ESLint major that can't read the `.eslintrc.json`
 * we just scaffolded.
 *
 * We only check the env var (not `useFlatConfig(tree)`) because the tree-
 * less fallback in `useFlatConfig` reads the CLI's own `require('eslint')`
 * version, which is unrelated to what the generator is about to install.
 */
export function versions(tree: Tree): PackageCompatVersions {
  const majorEslintVersion = getInstalledEslintMajorVersion(tree);
  const legacyRequested = process.env.ESLINT_USE_FLAT_CONFIG === 'false';

  if (majorEslintVersion != null) {
    if (legacyRequested && majorEslintVersion >= 10) {
      throw new Error(
        `ESLint v${majorEslintVersion} does not support the legacy "eslintrc" configuration format, but ESLINT_USE_FLAT_CONFIG=false was set. ` +
          `Unset the environment variable to scaffold a flat config, or downgrade ESLint to v9 or lower.`
      );
    }
    return backwardCompatibleVersions[majorEslintVersion] ?? latestVersions;
  }

  return legacyRequested ? backwardCompatibleVersions[8] : latestVersions;
}
