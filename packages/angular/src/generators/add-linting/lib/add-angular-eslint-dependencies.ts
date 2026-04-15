import {
  addDependenciesToPackageJson,
  type GeneratorCallback,
  type Tree,
} from '@nx/devkit';
import { useFlatConfig } from '@nx/eslint/src/utils/flat-config';
import { versions as eslintPkgVersions } from '@nx/eslint/src/utils/version-utils';
import { versions } from '../../utils/version-utils';
import { isBuildableLibraryProject } from './buildable-project';

export function addAngularEsLintDependencies(
  tree: Tree,
  projectName: string
): GeneratorCallback {
  const compatVersions = versions(tree);
  const angularEslintVersionToInstall = compatVersions.angularEslintVersion;
  const usesEslintFlatConfig = useFlatConfig(tree);
  const devDependencies = usesEslintFlatConfig
    ? {
        'angular-eslint': angularEslintVersionToInstall,
      }
    : {
        '@angular-eslint/eslint-plugin': angularEslintVersionToInstall,
        '@angular-eslint/eslint-plugin-template': angularEslintVersionToInstall,
        '@angular-eslint/template-parser': angularEslintVersionToInstall,
      };

  if ('typescriptEslintVersion' in compatVersions) {
    devDependencies['@typescript-eslint/utils'] = usesEslintFlatConfig
      ? eslintPkgVersions(tree).typescriptESLintVersion
      : compatVersions.typescriptEslintVersion;
  }

  if (isBuildableLibraryProject(tree, projectName)) {
    devDependencies['jsonc-eslint-parser'] =
      compatVersions.jsoncEslintParserVersion;
  }

  return addDependenciesToPackageJson(
    tree,
    {},
    devDependencies,
    undefined,
    true
  );
}
