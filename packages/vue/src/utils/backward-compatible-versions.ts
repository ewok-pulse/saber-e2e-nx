import * as latestVersions from './versions';

// Vue lint packages are keyed on the installed ESLint major, since that is
// what drives their peer-dep compatibility (Vue 2 is not supported by the
// Nx Vue plugin).
//
// Only the linting-related keys vary by ESLint major. Listing them
// explicitly avoids pulling Vue-core versions into the compat map.
export type EslintPackageVersionNames =
  | 'vueEslintConfigPrettierVersion'
  | 'vueEslintConfigTypescriptVersion'
  | 'eslintPluginVueVersion';

export type PackageCompatVersions = Record<EslintPackageVersionNames, string>;

export type VersionMap = {
  10: PackageCompatVersions;
  9: PackageCompatVersions;
  8: PackageCompatVersions;
};

export const backwardCompatibleVersions: VersionMap = {
  10: {
    vueEslintConfigPrettierVersion:
      latestVersions.vueEslintConfigPrettierVersion,
    vueEslintConfigTypescriptVersion:
      latestVersions.vueEslintConfigTypescriptVersion,
    eslintPluginVueVersion: latestVersions.eslintPluginVueVersion,
  },
  9: {
    vueEslintConfigPrettierVersion: '^10.2.0',
    vueEslintConfigTypescriptVersion: '^14.7.0',
    eslintPluginVueVersion: '^10.8.0',
  },
  8: {
    vueEslintConfigPrettierVersion: '^10.2.0',
    vueEslintConfigTypescriptVersion: '^11.0.3',
    eslintPluginVueVersion: '^9.16.1',
  },
};
