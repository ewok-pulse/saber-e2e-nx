import { performance } from 'node:perf_hooks';

performance.mark(`plugin worker ${process.pid} code loading -- start`);

// Enable V8's on-disk compile cache before any other module loads so the
// worker's own bootstrap (and subsequently the plugin) can benefit from
// cached bytecode on warm invocations.
import { enablePluginCompileCache } from './compile-cache';
enablePluginCompileCache();

import { logger } from '../../../utils/logger';
import { createSerializableError } from '../../../utils/serializable-error';
import type { LoadedNxPlugin } from '../loaded-nx-plugin';
import { consumeMessage, isPluginWorkerMessage } from './messaging';
import {
  PluginTransport,
  SocketTransport,
  WorkerThreadTransport,
} from './plugin-transport';
import { setPluginWorkerHostTransport } from './worker-streaming';

import { unlinkSync } from 'fs';
import { createServer } from 'net';
import { isMainThread, parentPort, workerData } from 'node:worker_threads';
import { startAnalytics } from '../../../analytics';
import '../../../utils/perf-logging';

type Environment = Pick<
  NodeJS.ProcessEnv,
  'NX_PERF_LOGGING' | 'NX_PLUGIN_NO_TIMEOUTS'
>;

const environment: Environment = process.env as Environment;

// When launched as a worker thread, the host supplies { name } via workerData
// and we communicate over parentPort. Otherwise we fall back to the legacy
// subprocess bootstrap that reads a socket path from argv and listens for a
// connection from the host.
const RUNNING_AS_THREAD = !isMainThread && parentPort !== null;

startAnalytics();

performance.mark(`plugin worker ${process.pid} code loading -- end`);
performance.measure(
  `plugin worker ${process.pid} code loading`,
  `plugin worker ${process.pid} code loading -- start`,
  `plugin worker ${process.pid} code loading -- end`
);

global.NX_GRAPH_CREATION = true;
global.NX_PLUGIN_WORKER = true;
let plugin: LoadedNxPlugin;

function runWithTransport(
  transport: PluginTransport,
  { name, onClose }: { name: string; onClose: () => void }
): void {
  setPluginWorkerHostTransport(transport);

  let loadErrorTimeout = setErrorTimeout(
    10_000,
    `Plugin Worker for ${name} is exiting as it did not receive a load message within 10 seconds of connecting. ` +
      'This likely indicates that the host process was terminated before the worker could be instructed to load the plugin. ' +
      'If you are seeing this issue, please report it to the Nx team at https://github.com/nrwl/nx/issues.'
  );

  transport.onMessage((message) => {
    if (!isPluginWorkerMessage(message)) return;
    void consumeMessage(transport, message, {
      load: async ({
        plugin: pluginConfiguration,
        root,
        name: pluginName,
        pluginPath,
        shouldRegisterTSTranspiler,
      }) => {
        loadErrorTimeout?.clear();
        chdirForLoad(pluginName, root);
        return withErrorHandling(async () => {
          const { loadResolvedNxPluginAsync } = await Promise.resolve(
            require(require.resolve('../load-resolved-plugin'))
          );

          if (shouldRegisterTSTranspiler) {
            (
              require('../transpiler') as typeof import('../transpiler')
            ).registerPluginTSTranspiler();
          }
          plugin = await loadResolvedNxPluginAsync(
            pluginConfiguration,
            pluginPath,
            pluginName
          );
          logger.verbose(
            `[plugin-worker] "${pluginName}" (pid: ${process.pid}) loaded successfully`
          );
          return {
            name: plugin.name,
            include: plugin.include,
            exclude: plugin.exclude,
            createNodesPattern: plugin.createNodes?.[0],
            hasCreateDependencies:
              'createDependencies' in plugin && !!plugin.createDependencies,
            hasProcessProjectGraph:
              'processProjectGraph' in plugin && !!plugin.processProjectGraph,
            hasCreateMetadata:
              'createMetadata' in plugin && !!plugin.createMetadata,
            hasPreTasksExecution:
              'preTasksExecution' in plugin && !!plugin.preTasksExecution,
            hasPostTasksExecution:
              'postTasksExecution' in plugin && !!plugin.postTasksExecution,
            success: true as const,
          };
        });
      },
      createNodes: async ({ configFiles, context }) =>
        withErrorHandling(async () => {
          const result = await plugin.createNodes[1](configFiles, context);
          return { result, success: true as const };
        }),
      createDependencies: async ({ context }) =>
        withErrorHandling(async () => {
          const result = await plugin.createDependencies(context);
          return { dependencies: result, success: true as const };
        }),
      createMetadata: async ({ graph, context }) =>
        withErrorHandling(async () => {
          const result = await plugin.createMetadata(graph, context);
          return { metadata: result, success: true as const };
        }),
      preTasksExecution: async ({ context }) =>
        withErrorHandling(async () => {
          const mutations = await plugin.preTasksExecution?.(context);
          return { success: true as const, mutations };
        }),
      postTasksExecution: async ({ context }) =>
        withErrorHandling(() => plugin.postTasksExecution?.(context)),
      setWorkerEnv: (env) =>
        withErrorHandling(() => {
          for (const envKey in env) {
            process.env[envKey] = env[envKey];
          }
        }),
    });
  });

  transport.onClose(onClose);
}

/**
 * In subprocess mode each worker gets its own process, so chdir'ing into the
 * workspace root is cheap and isolated. In thread mode process.chdir() is
 * forbidden by Node (it would mutate state shared with the host), so the
 * plugin inherits the host's cwd. The host runs from the workspace root on
 * every `nx` invocation, so this is effectively the same cwd. If the host
 * ever drifts from that invariant and a plugin's requested root differs, we
 * warn instead of throwing — the plugin's own code should consume
 * context.workspaceRoot rather than process.cwd().
 */
function chdirForLoad(pluginName: string, root: string): void {
  if (!RUNNING_AS_THREAD) {
    process.chdir(root);
    return;
  }
  if (process.cwd() !== root) {
    logger.verbose(
      `[plugin-worker] "${pluginName}" requested root "${root}" but thread cwd is "${process.cwd()}". ` +
        `Worker threads cannot chdir; plugin should rely on context.workspaceRoot instead.`
    );
  }
}

if (RUNNING_AS_THREAD) {
  const { name } = (workerData ?? {}) as { name?: string };
  const pluginName = name ?? 'unknown';
  logger.verbose(
    `[plugin-worker] "${pluginName}" (thread ${process.pid}) initialized`
  );
  runWithTransport(new WorkerThreadTransport(parentPort!), {
    name: pluginName,
    onClose: () => {
      // The host terminates us via worker.terminate(); no cleanup here.
    },
  });
} else {
  const socketPath = process.argv[2];
  const expectedPluginName = process.argv[3];

  const CONNECT_TIMEOUT_MS = 30_000;

  const connectErrorTimeout = setErrorTimeout(
    CONNECT_TIMEOUT_MS,
    `The plugin worker for ${expectedPluginName} is exiting as it was not connected to within ${CONNECT_TIMEOUT_MS / 1000} seconds. ` +
      'Plugin workers expect to receive a socket connection from the parent process shortly after being started. ' +
      'If you are seeing this issue, please report it to the Nx team at https://github.com/nrwl/nx/issues.'
  );

  const server = createServer((socket) => {
    connectErrorTimeout?.clear();
    logger.verbose(
      `[plugin-worker] "${expectedPluginName}" (pid: ${process.pid}) connected`
    );
    runWithTransport(new SocketTransport(socket), {
      name: expectedPluginName,
      onClose: () => {
        try {
          unlinkSync(socketPath);
        } catch {}
        process.exit(0);
      },
    });
  });

  server.listen(socketPath);
  logger.verbose(
    `[plugin-worker] "${expectedPluginName}" (pid: ${process.pid}) listening on ${socketPath}`
  );

  const exitHandler = (exitCode: number) => () => {
    server.close();
    try {
      unlinkSync(socketPath);
    } catch (e) {}
    process.exit(exitCode);
  };

  const events = ['SIGINT', 'SIGTERM', 'SIGQUIT', 'exit'];
  events.forEach((event) => process.once(event, exitHandler(0)));
  process.once('uncaughtException', exitHandler(1));
  process.once('unhandledRejection', exitHandler(1));
}

async function withErrorHandling(
  cb: () => void | Promise<void>
): Promise<{ success: true } | { success: false; error: Error }>;
async function withErrorHandling<T>(
  cb: () => T | Promise<T>
): Promise<T | { success: false; error: Error }>;
async function withErrorHandling<T>(
  cb: () => T | Promise<T>
): Promise<T | { success: true } | { success: false; error: Error }> {
  try {
    const result = await cb();
    return result ?? ({ success: true as const } as any);
  } catch (e) {
    return {
      success: false as const,
      error: createSerializableError(e) as Error,
    };
  }
}

function setErrorTimeout(
  timeoutMs: number,
  errorMessage: string
): { clear: () => void } | undefined {
  if (environment.NX_PLUGIN_NO_TIMEOUTS === 'true') {
    return;
  }
  let cleared = false;
  const timeout = setTimeout(() => {
    if (!cleared) {
      console.error(errorMessage);
      // In thread mode, exit the thread (parent will see 'exit' event);
      // in subprocess mode, kill the whole process.
      if (RUNNING_AS_THREAD) {
        process.exit(1);
      } else {
        process.exit(1);
      }
    }
  }, timeoutMs).unref();
  return {
    clear: () => {
      cleared = true;
      clearTimeout(timeout);
    },
  };
}
