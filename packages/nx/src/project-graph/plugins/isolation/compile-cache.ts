import * as nodeModule from 'node:module';
import { join } from 'node:path';
import { workspaceDataDirectoryForWorkspace } from '../../../utils/cache-directory';
import { workspaceRoot } from '../../../utils/workspace-root';

/**
 * Enables V8's on-disk bytecode cache for the current process so subsequent
 * plugin-worker invocations skip module parse + bytecode generation on
 * unchanged source.
 *
 * No-op on Node versions without the API and on NX_PLUGIN_COMPILE_CACHE=false.
 * Returns the cache dir path if enabled, null otherwise. All errors are
 * swallowed — the compile cache is a pure performance optimization and should
 * never break the worker.
 *
 * Cache lives under `workspaceDataDirectory()/v8-cache`, so `nx reset` and
 * `nx reset --onlyWorkspaceData` clear it transitively alongside the other
 * workspace-data state (see packages/nx/src/command-line/reset/reset.ts).
 */
export function enablePluginCompileCache(
  // Injected dependencies for testing; production callers leave these blank.
  injected: {
    getRoot?: () => string;
    // `unknown` rather than `Function | undefined` so tests can simulate a
    // pre-22.8 Node by passing a non-function value.
    enableImpl?: unknown;
  } = {}
): string | null {
  if (process.env.NX_PLUGIN_COMPILE_CACHE === 'false') return null;
  const enable =
    'enableImpl' in injected
      ? injected.enableImpl
      : (
          nodeModule as unknown as {
            enableCompileCache?: (dir: string) => void;
          }
        ).enableCompileCache;
  if (typeof enable !== 'function') return null;
  try {
    const root = injected.getRoot ? injected.getRoot() : workspaceRoot;
    const cacheDir = join(workspaceDataDirectoryForWorkspace(root), 'v8-cache');
    enable(cacheDir);
    return cacheDir;
  } catch {
    return null;
  }
}
