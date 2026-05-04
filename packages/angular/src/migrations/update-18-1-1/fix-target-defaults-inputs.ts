import {
  getProjects,
  type Tree,
  joinPathFragments,
  formatFiles,
  readNxJson,
} from '@nx/devkit';
import { upsertTargetDefault } from '@nx/devkit/src/generators/target-defaults-utils';
import { normalizeTargetDefaults } from '@nx/devkit/src/utils/normalize-target-defaults';

export default async function (tree: Tree) {
  if (!isWebpackBrowserUsed(tree)) {
    return;
  }
  ensureTargetDefaultsContainProductionInputs(tree);

  await formatFiles(tree);
}

function ensureTargetDefaultsContainProductionInputs(tree: Tree) {
  const nxJson = readNxJson(tree);
  const webpackExecutor = '@nx/angular:webpack-browser';
  const mfEnvVar = 'NX_MF_DEV_SERVER_STATIC_REMOTES';

  const existing = normalizeTargetDefaults(nxJson?.targetDefaults).find(
    (e) =>
      e.executor === webpackExecutor &&
      e.target === undefined &&
      e.projects === undefined &&
      e.source === undefined
  );

  const inputs = [
    ...(existing?.inputs ?? ['production', '^production', { env: mfEnvVar }]),
  ];

  if (!inputs.includes('production')) {
    inputs.push('production');
  }
  if (!inputs.includes('^production')) {
    inputs.push('^production');
  }

  let mfEnvVarExists = false;
  for (const input of inputs) {
    if (typeof input === 'object' && input['env'] === mfEnvVar) {
      mfEnvVarExists = true;
      break;
    }
  }
  if (!mfEnvVarExists) {
    inputs.push({ env: mfEnvVar });
  }

  upsertTargetDefault(tree, { executor: webpackExecutor, inputs });
}

function isWebpackBrowserUsed(tree: Tree) {
  const projects = getProjects(tree);
  for (const project of projects.values()) {
    const targets = project.targets || {};
    for (const [_, target] of Object.entries(targets)) {
      if (
        target.executor === '@nx/angular:webpack-browser' &&
        (tree.exists(
          joinPathFragments(project.root, 'module-federation.config.ts')
        ) ||
          tree.exists(
            joinPathFragments(project.root, 'module-federation.config.js')
          ))
      ) {
        return true;
      }
    }
  }
  return false;
}
