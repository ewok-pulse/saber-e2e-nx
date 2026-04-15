import * as latestVersions from './versions';

export type PackageVersionNames = Exclude<
  keyof typeof latestVersions,
  'nxVersion'
>;

export type PackageCompatVersions = Record<PackageVersionNames, string>;

export type VersionMap = {
  10: PackageCompatVersions;
  9: PackageCompatVersions;
  8: PackageCompatVersions;
};

export const backwardCompatibleVersions: VersionMap = {
  10: { ...latestVersions },
  9: {
    eslintVersion: '^9.8.0',
    eslintJsVersion: '^9.8.0',
    eslintrcVersion: '^3.3.0',
    eslintConfigPrettierVersion: '^10.0.0',
    eslintCompatVersion: '^1.4.1',
    typescriptESLintVersion: '^8.40.0',
    jsoncEslintParserVersion: '^2.1.0',
  },
  8: {
    eslintVersion: '~8.57.0',
    // @eslint/js and @eslint/compat are not installed on the legacy .eslintrc
    // path, but the compat map must be complete for every major.
    eslintJsVersion: '^9.8.0',
    eslintrcVersion: '^2.1.1',
    eslintConfigPrettierVersion: '^10.0.0',
    eslintCompatVersion: '^1.4.1',
    typescriptESLintVersion: '^7.16.0',
    jsoncEslintParserVersion: '^2.1.0',
  },
};
