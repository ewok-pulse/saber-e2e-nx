import { ChildProcess, spawn } from 'child_process';
import { Socket } from 'net';
import { Readable, Writable } from 'stream';
import path = require('path');

import type { PluginConfiguration } from '../../../config/nx-json';
import type { ProjectGraph } from '../../../config/project-graph';
import { serverLogger } from '../../../daemon/logger';
import { getPluginOsSocketPath } from '../../../daemon/socket-utils';
import { getNxRequirePaths } from '../../../utils/installation-directory';
import { logger } from '../../../utils/logger';
import { ProgressTopics } from '../../../utils/progress-topics';
import { waitForSocketConnection } from '../../../utils/wait-for-socket-connection';
import type { RawProjectGraphDependency } from '../../project-graph-builder';
import { LoadedNxPlugin } from '../loaded-nx-plugin';
import type {
  CreateDependenciesContext,
  CreateMetadataContext,
  CreateNodesContextV2,
  CreateNodesResult,
  PostTasksExecutionContext,
  PreTasksExecutionContext,
  ProjectsMetadata,
} from '../public-api';
import { resolveNxPlugin } from '../resolve-plugin';
import type {
  MessageResult,
  PluginWorkerLoadResult,
  PluginWorkerMessage,
  PluginWorkerNotification,
} from './messaging';
import { isPluginWorkerNotification, isPluginWorkerResult } from './messaging';
import { Worker as NodeWorker } from 'node:worker_threads';
import {
  PluginTransport,
  PluginTransportMessage,
  SocketTransport,
  WorkerThreadTransport,
} from './plugin-transport';
import {
  Hook,
  Phase,
  PluginLifecycleManager,
} from './plugin-lifecycle-manager';
import { getPluginWorkerTransport } from './transport-flag';

const PLUGIN_TIMEOUT_HINT_TEXT =
  'As a last resort, you can set NX_PLUGIN_NO_TIMEOUTS=true to bypass this timeout.';

const MINUTES = 10;

const MAX_MESSAGE_WAIT =
  process.env.NX_PLUGIN_NO_TIMEOUTS === 'true'
    ? // Registering a timeout prevents the process from exiting
      // if the call to a plugin happens to be the only thing
      // keeping the process alive. As such, even if timeouts are disabled
      // we need to register one. 2147483647 is the max timeout
      // that Node.js allows, and is equivalent to 24.8 days.
      2147483647
    : 1000 * 60 * MINUTES;

export type LoadResultPayload = Extract<
  PluginWorkerLoadResult['payload'],
  { success: true }
>;

export class IsolatedPlugin implements LoadedNxPlugin {
  readonly name: string;
  readonly include?: string[];
  readonly exclude?: string[];

  readonly createNodes?: [
    filePattern: string,
    fn: (
      matchedFiles: string[],
      context: CreateNodesContextV2
    ) => Promise<
      Array<readonly [plugin: string, file: string, result: CreateNodesResult]>
    >,
  ];
  readonly createDependencies?: (
    context: CreateDependenciesContext
  ) => Promise<RawProjectGraphDependency[]>;
  readonly createMetadata?: (
    graph: ProjectGraph,
    context: CreateMetadataContext
  ) => Promise<ProjectsMetadata>;
  readonly preTasksExecution?: (
    context: PreTasksExecutionContext
  ) => Promise<NodeJS.ProcessEnv>;
  readonly postTasksExecution?: (
    context: PostTasksExecutionContext
  ) => Promise<void>;

  // Worker state
  private worker: ChildProcess | NodeWorker | null = null;
  private transport: PluginTransport | null = null;
  private _alive = false;
  private _connectPromise: Promise<LoadResultPayload> | null = null;
  private txId = 0;
  private pendingCount = 0;

  // Typed response handlers keyed by transaction ID
  private responseHandlers = new Map<
    string,
    {
      onMessage: (msg: PluginTransportMessage) => void;
      onError: (error: Error) => void;
    }
  >();

  // Configuration for restart
  private readonly plugin: PluginConfiguration;
  private readonly root: string;
  private readonly pluginPath: string;
  private readonly shouldRegisterTSTranspiler: boolean;

  private lifecycle: PluginLifecycleManager;
  private exitHandler: (() => void) | null = null;

  /**
   * Creates and loads an isolated plugin worker.
   */
  static async load(
    plugin: PluginConfiguration,
    root: string,
    index?: number
  ): Promise<IsolatedPlugin> {
    const moduleName = typeof plugin === 'string' ? plugin : plugin.plugin;
    const { name, pluginPath, shouldRegisterTSTranspiler } =
      await resolveNxPlugin(moduleName, root, getNxRequirePaths(root));

    const instance = new IsolatedPlugin(
      plugin,
      root,
      name,
      pluginPath,
      shouldRegisterTSTranspiler,
      index
    );

    const loadResult = await instance.spawnAndConnect();
    instance.setupHooks(loadResult);
    return instance;
  }

  private constructor(
    plugin: PluginConfiguration,
    root: string,
    name: string,
    pluginPath: string,
    shouldRegisterTSTranspiler: boolean,
    public readonly index?: number
  ) {
    this.plugin = plugin;
    this.root = root;
    this.name = name;
    this.pluginPath = pluginPath;
    this.shouldRegisterTSTranspiler = shouldRegisterTSTranspiler;
  }

  private async spawnAndConnect(): Promise<LoadResultPayload> {
    const transportMode = getPluginWorkerTransport();
    const { worker, transport } =
      transportMode === 'threads'
        ? await startPluginWorkerThread(this.name)
        : await startPluginWorker(this.name);
    this.worker = worker;
    this.transport = transport;

    this.registerProcessMetrics();

    this.exitHandler = () => {
      this._alive = false;
      this._connectPromise = null;
      if (this.worker && isChildProcess(this.worker)) {
        if (this.worker.stdout) {
          this.worker.stdout.unpipe(process.stdout);
        }
        if (this.worker.stderr) {
          this.worker.stderr.unpipe(process.stderr);
        }
      }
      // Reject all pending requests
      const error = new Error(
        `Plugin worker "${this.name}" exited unexpectedly.`
      );
      for (const { onError } of this.responseHandlers.values()) {
        onError(error);
      }
      this.responseHandlers.clear();
    };
    if (isChildProcess(worker)) {
      worker.on('exit', this.exitHandler);
    } else {
      worker.on('exit', this.exitHandler);
      worker.on('error', (err) => {
        logger.verbose(
          `[isolated-plugin] worker thread error for "${this.name}": ${err.message}`
        );
        this.exitHandler?.();
      });
    }

    transport.onMessage(this.handleTransportMessage);

    return this.sendLoadMessage();
  }

  /**
   * Ensures the worker is alive, restarting it if necessary.
   * Called before each hook execution to handle plugins that were
   * eagerly shutdown (e.g., post-task-only plugins).
   *
   * Uses a stored promise to coalesce concurrent restart attempts
   * so that only one worker is ever spawned at a time.
   */
  private async ensureAlive(): Promise<void> {
    if (this._alive) {
      return;
    }

    if (!this._connectPromise) {
      logger.verbose(`[plugin-client] restarting worker for "${this.name}"`);
      this._connectPromise = this.spawnAndConnect().catch((err) => {
        // Clear the cached promise so subsequent calls can retry
        // instead of re-awaiting a permanently-rejected promise.
        this._connectPromise = null;
        throw err;
      });
    }

    await this._connectPromise;
  }

  private handleTransportMessage = (message: PluginTransportMessage) => {
    if (isPluginWorkerNotification(message)) {
      handlePluginWorkerNotification(message);
      return;
    }
    if (!isPluginWorkerResult(message)) {
      return;
    }
    const pending = this.responseHandlers.get(message.tx);
    if (pending) {
      this.responseHandlers.delete(message.tx);
      pending.onMessage(message);
    }
  };

  private sendLoadMessage(): Promise<LoadResultPayload> {
    return new Promise((resolve, reject) => {
      const tx = this.generateTxId('load');

      const timeout = setTimeout(() => {
        this.responseHandlers.delete(tx);
        reject(
          new Error(
            `Loading "${
              typeof this.plugin === 'string' ? this.plugin : this.plugin.plugin
            }" timed out after ${MINUTES} minutes. ${PLUGIN_TIMEOUT_HINT_TEXT}`
          )
        );
      }, MAX_MESSAGE_WAIT);

      this.responseHandlers.set(tx, {
        onMessage: (msg) => {
          clearTimeout(timeout);
          if (msg.type !== 'loadResult') {
            reject(new Error(`Expected loadResult, got ${msg.type}`));
            return;
          }
          const payload = msg.payload as PluginWorkerLoadResult['payload'];
          if (payload.success === false) {
            reject(payload.error);
          } else {
            this._alive = true;
            resolve(payload);
          }
        },
        onError: (error) => {
          clearTimeout(timeout);
          reject(error);
        },
      });

      this.transport!.send({
        type: 'load',
        payload: {
          plugin: this.plugin,
          root: this.root,
          name: this.name,
          pluginPath: this.pluginPath,
          shouldRegisterTSTranspiler: this.shouldRegisterTSTranspiler,
        },
        tx,
      });
    });
  }

  private setupHooks(loadResult: LoadResultPayload): void {
    // These are set via Object.defineProperty to work around readonly
    (this as { name: string }).name = loadResult.name;
    (this as { include?: string[] }).include = loadResult.include;
    (this as { exclude?: string[] }).exclude = loadResult.exclude;

    const registeredHooks: Hook[] = hooks(
      loadResult.createNodesPattern && 'createNodes',
      loadResult.hasCreateDependencies && 'createDependencies',
      loadResult.hasCreateMetadata && 'createMetadata',
      loadResult.hasPreTasksExecution && 'preTasksExecution',
      loadResult.hasPostTasksExecution && 'postTasksExecution'
    );

    this.lifecycle = new PluginLifecycleManager(registeredHooks);

    const shutdown = (hookName: Hook) => this.shutdownIfInactive(hookName);
    const wrap = <TArgs extends unknown[], TReturn>(
      hook: Hook,
      hookFn: (...args: TArgs) => Promise<TReturn>
    ) =>
      this.lifecycle.wrapHook(
        hook,
        async (...args: TArgs) => {
          await this.ensureAlive();
          return hookFn(...args);
        },
        () => shutdown(hook)
      );

    if (loadResult.createNodesPattern) {
      (this as { createNodes: IsolatedPlugin['createNodes'] }).createNodes = [
        loadResult.createNodesPattern,
        wrap('createNodes', async (configFiles, ctx) => {
          const result = await this.sendRequest('createNodes', {
            configFiles,
            context: ctx,
          });
          if (result.success === false) {
            throw result.error;
          }
          return result.result;
        }),
      ];
    }

    if (loadResult.hasCreateDependencies) {
      (
        this as { createDependencies: IsolatedPlugin['createDependencies'] }
      ).createDependencies = wrap('createDependencies', async (ctx) => {
        const result = await this.sendRequest('createDependencies', {
          context: ctx,
        });
        if (result.success === false) {
          throw result.error;
        }
        return result.dependencies;
      });
    }

    if (loadResult.hasCreateMetadata) {
      (
        this as { createMetadata: IsolatedPlugin['createMetadata'] }
      ).createMetadata = wrap('createMetadata', async (graph, ctx) => {
        const result = await this.sendRequest('createMetadata', {
          graph,
          context: ctx,
        });
        if (result.success === false) {
          throw result.error;
        }
        return result.metadata;
      });
    }

    if (loadResult.hasPreTasksExecution) {
      (
        this as { preTasksExecution: IsolatedPlugin['preTasksExecution'] }
      ).preTasksExecution = wrap('preTasksExecution', async (context) => {
        const result = await this.sendRequest('preTasksExecution', {
          context,
        });
        if (result.success === false) {
          throw result.error;
        }
        return result.mutations;
      });
    }

    if (loadResult.hasPostTasksExecution) {
      (
        this as { postTasksExecution: IsolatedPlugin['postTasksExecution'] }
      ).postTasksExecution = wrap('postTasksExecution', async (context) => {
        const result = await this.sendRequest('postTasksExecution', {
          context,
        });
        if (result.success === false) {
          throw result.error;
        }
      });
    }

    // Shut down immediately if no graph phase hooks
    if (this.lifecycle.shouldShutdownImmediately()) {
      this.shutdown();
    }
  }

  private generateTxId(type: string): string {
    const handle = this.worker;
    const identifier = handle
      ? isChildProcess(handle)
        ? (handle.pid ?? '')
        : handle.threadId
      : '';
    return `${this.name}:${identifier}:${type}:${this.txId++}`;
  }

  private sendRequest<TType extends PluginWorkerMessage['type']>(
    type: TType,
    payload: Extract<PluginWorkerMessage, { type: TType }>['payload']
  ): Promise<MessageResult<TType>['payload']> {
    const tx = this.generateTxId(type);
    this.pendingCount++;

    return new Promise<MessageResult<TType>['payload']>((resolve, reject) => {
      const expectedResultType = `${type}Result`;

      const timeout = setTimeout(() => {
        this.responseHandlers.delete(tx);
        this.pendingCount--;
        reject(
          new Error(
            `${this.name} timed out after ${MINUTES} minutes during ${type}. ${PLUGIN_TIMEOUT_HINT_TEXT}`
          )
        );
      }, MAX_MESSAGE_WAIT);

      this.responseHandlers.set(tx, {
        onMessage: (msg) => {
          clearTimeout(timeout);
          this.pendingCount--;

          if (msg.type !== expectedResultType) {
            reject(
              new Error(`Expected ${expectedResultType}, got ${msg.type}`)
            );
            return;
          }

          resolve(
            (msg as Extract<PluginTransportMessage, { payload: unknown }>)
              .payload as MessageResult<TType>['payload']
          );
        },
        onError: (error) => {
          clearTimeout(timeout);
          this.pendingCount--;
          reject(error);
        },
      });

      this.transport!.send({
        type,
        payload,
        tx,
      } as PluginWorkerMessage);
    });
  }

  private shutdownIfInactive(hookName: Hook): void {
    if (this.pendingCount > 0) {
      logger.verbose(
        `[isolated-plugin] worker for "${this.name}" has ${this.pendingCount} pending request(s), not shutting down yet`
      );
      return;
    }
    logger.verbose(
      `[isolated-plugin] shutting down worker for "${this.name}" after ${hookName}`
    );
    this.shutdown();
  }

  async setWorkerEnv(env: Record<string, string>): Promise<void> {
    if (!this._alive) {
      return;
    }
    const result = await this.sendRequest('setWorkerEnv', env);
    if (result.success === false) {
      throw result.error;
    }
  }

  notifyPhaseAborted(phase: Phase, lastCompletedHook: Hook): void {
    if (this.lifecycle?.notifyPhaseAborted(phase, lastCompletedHook)) {
      this.shutdownIfInactive(lastCompletedHook);
    }
  }

  shutdown(): void {
    if (!this._alive) return;
    this._alive = false;
    this._connectPromise = null;

    if (this.worker && this.exitHandler) {
      this.worker.off('exit', this.exitHandler);
    }

    if (this.worker && isChildProcess(this.worker)) {
      if (this.worker.stdout) {
        this.worker.stdout.unpipe(process.stdout);
        this.worker.stdout.destroy();
      }
      if (this.worker.stderr) {
        this.worker.stderr.unpipe(process.stderr);
        this.worker.stderr.destroy();
      }
    }
    if (this.transport) {
      this.transport.close();
    }
    if (this.worker && !isChildProcess(this.worker)) {
      // Fire-and-forget; host doesn't need to await thread teardown.
      this.worker.terminate().catch(() => {});
    }

    this.worker = null;
    this.transport = null;
    this.exitHandler = null;
  }

  private registerProcessMetrics(): void {
    if (!this.worker || !isChildProcess(this.worker) || !this.worker.pid)
      return;
    const workerPid = this.worker.pid;
    (async () => {
      try {
        const { isOnDaemon } = await require(
          require.resolve('../../../daemon/is-on-daemon')
        );
        if (!isOnDaemon()) {
          const { getProcessMetricsService } = await require(
            require.resolve('../../../tasks-runner/process-metrics-service')
          );
          getProcessMetricsService().registerMainCliSubprocess(
            workerPid,
            `${this.name}${this.index !== undefined ? ` (${this.index})` : ''}`
          );
        }
      } catch {
        // Silently ignore - metrics collection is optional
      }
    })();
  }
}

// --- Worker Spawning Utilities ---

function isChildProcess(
  worker: ChildProcess | NodeWorker
): worker is ChildProcess {
  return 'kill' in worker && typeof worker.kill === 'function';
}

global.nxPluginWorkerCount ??= 0;

async function startPluginWorker(name: string) {
  performance.mark(`start-plugin-worker:${name}`);

  const isWorkerTypescript = path.extname(__filename) === '.ts';
  const workerPath = path.join(
    __dirname,
    isWorkerTypescript ? 'plugin-worker.ts' : 'plugin-worker.js'
  );

  const env: Record<string, string> = {
    ...process.env,
    ...(isWorkerTypescript
      ? {
          TS_NODE_PROJECT: path.join(
            __dirname,
            '../../../../tsconfig.lib.json'
          ),
          TS_NODE_COMPILER_OPTIONS: JSON.stringify({
            moduleResolution: 'node',
            module: 'commonjs',
          }),
        }
      : {}),
  };

  const ipcPath = getPluginOsSocketPath(
    [process.pid, global.nxPluginWorkerCount++, performance.now()].join('-')
  );

  const worker = spawn(
    process.execPath,
    [
      ...(isWorkerTypescript ? ['--require', 'ts-node/register'] : []),
      workerPath,
      ipcPath,
      name,
    ],
    {
      stdio: ['ignore', 'pipe', 'pipe'],
      env,
      detached: true,
      shell: false,
      windowsHide: true,
    }
  );

  logger.verbose(
    `[isolated-plugin] spawned worker for "${name}" (pid: ${worker.pid}, socket: ${ipcPath})`
  );

  const stdoutMaxListeners = process.stdout.getMaxListeners();
  const stderrMaxListeners = process.stderr.getMaxListeners();
  if (stdoutMaxListeners !== 0) {
    process.stdout.setMaxListeners(stdoutMaxListeners + 1);
  }
  if (stderrMaxListeners !== 0) {
    process.stderr.setMaxListeners(stderrMaxListeners + 1);
  }

  pipeAndUnrefChildStream(worker.stdout, process.stdout, 'stdout');
  pipeAndUnrefChildStream(worker.stderr, process.stderr, 'stderr');

  worker.unref();

  try {
    const socket = await connectToWorker(worker, ipcPath, name);
    return {
      worker,
      transport: new SocketTransport(socket) as PluginTransport,
    };
  } finally {
    performance.mark(`start-plugin-worker-end:${name}`);
    performance.measure(
      `start-plugin-worker:${name}`,
      `start-plugin-worker:${name}`,
      `start-plugin-worker-end:${name}`
    );
  }
}

async function startPluginWorkerThread(
  name: string
): Promise<{ worker: NodeWorker; transport: PluginTransport }> {
  performance.mark(`start-plugin-worker-thread:${name}`);

  const isWorkerTypescript = path.extname(__filename) === '.ts';
  const workerPath = path.join(
    __dirname,
    isWorkerTypescript ? 'plugin-worker.ts' : 'plugin-worker.js'
  );

  const execArgv = isWorkerTypescript ? ['--require', 'ts-node/register'] : [];

  const worker = new NodeWorker(workerPath, {
    workerData: { name },
    execArgv,
    stdout: false,
    stderr: false,
    env: isWorkerTypescript
      ? {
          ...process.env,
          TS_NODE_PROJECT: path.join(
            __dirname,
            '../../../../tsconfig.lib.json'
          ),
          TS_NODE_COMPILER_OPTIONS: JSON.stringify({
            moduleResolution: 'node',
            module: 'commonjs',
          }),
        }
      : (process.env as NodeJS.ProcessEnv),
  });

  logger.verbose(
    `[isolated-plugin] spawned worker thread for "${name}" (threadId: ${worker.threadId})`
  );

  const transport = new WorkerThreadTransport(workerToMessagePort(worker));

  performance.mark(`start-plugin-worker-thread-end:${name}`);
  performance.measure(
    `start-plugin-worker-thread:${name}`,
    `start-plugin-worker-thread:${name}`,
    `start-plugin-worker-thread-end:${name}`
  );

  return { worker, transport };
}

/**
 * Adapts a worker_threads.Worker into a MessagePort-compatible shape so
 * WorkerThreadTransport can talk to it through the same interface that works
 * on the worker side (where parentPort IS a MessagePort).
 *
 * Only the handful of methods WorkerThreadTransport actually uses are
 * forwarded.
 */
function workerToMessagePort(
  worker: NodeWorker
): import('worker_threads').MessagePort {
  return {
    on: (event: string, handler: (...args: any[]) => void) => {
      if (event === 'message') worker.on('message', handler);
      else if (event === 'close') worker.on('exit', handler);
      return undefined as any;
    },
    postMessage: (msg: any) => worker.postMessage(msg),
    close: () => {
      // Worker lifecycle is owned by IsolatedPlugin.shutdown via terminate().
    },
  } as any;
}

async function connectToWorker(
  worker: ChildProcess,
  ipcPath: string,
  name: string
): Promise<Socket> {
  const abortController = new AbortController();
  let earlyExitError: Error | null = null;

  // If the worker exits before we connect, abort polling immediately
  // rather than burning through attempts against a dead socket.
  worker.once('exit', (code) => {
    if (!abortController.signal.aborted) {
      earlyExitError = new Error(
        `Plugin worker for "${name}" exited with code ${code} before the connection was established.`
      );
      abortController.abort();
    }
  });

  const socket = await waitForSocketConnection(ipcPath, {
    signal: abortController.signal,
  });

  if (socket) {
    abortController.abort();
    socket.unref();
    logger.verbose(
      `[isolated-plugin] connected to worker for "${name}" (pid: ${worker.pid})`
    );
    return socket;
  }

  if (earlyExitError) {
    throw earlyExitError;
  }
  throw new Error(`Failed to start plugin worker for plugin ${name}`);
}

function getTypeName(u: unknown): string {
  if (u === null) return 'null';
  if (u === undefined) return 'undefined';
  if (typeof u !== 'object') return typeof u;
  if (Array.isArray(u)) {
    const innerTypes = u.map((el) => getTypeName(el));
    return `Array<${Array.from(new Set(innerTypes)).join('|')}>`;
  }
  return u.constructor?.name ?? 'unknown object';
}

function detectAlternativeRuntime(): 'bun' | 'deno' | null {
  if ('Bun' in globalThis && typeof (globalThis as any).Bun !== 'undefined') {
    return 'bun';
  }
  if ('Deno' in globalThis && typeof (globalThis as any).Deno !== 'undefined') {
    return 'deno';
  }
  return null;
}

function pipeAndUnrefChildStream(
  source: Readable | null,
  destination: Writable,
  streamName: 'stdout' | 'stderr'
): void {
  if (!source) {
    return;
  }

  source.pipe(destination);

  if (source instanceof Socket) {
    source.unref();
    return;
  }

  if (typeof (source as any).unref === 'function') {
    (source as any).unref();
    return;
  }

  const runtime = detectAlternativeRuntime();
  if (runtime) {
    console.warn(
      `[NX] worker.${streamName} does not support unref() in ${runtime}. ` +
        `This may cause the process to hang when waiting for plugin workers to exit. ` +
        `This is a known limitation of ${runtime}'s Node.js compatibility layer.`
    );
  } else {
    console.warn(
      `[NX] worker.${streamName} is not a net.Socket and does not have an unref() method. ` +
        `Expected Socket, got ${getTypeName(source)}. ` +
        `This may cause the process to hang when waiting for plugin workers to exit.`
    );
  }
}

// --- Utility functions ---

type Falsy = false | 0 | '' | null | undefined | 0n;

function hooks(...array: Array<Hook | Falsy>): Array<Hook> {
  return array.filter((v): v is Hook => !!v);
}

// When the host process is the daemon, broadcast the log notification
// to every client subscribed to the graph-construction topic so the
// line surfaces in their terminal. When the host is the direct CLI
// there is no client to notify, so the log line goes straight to
// stdout/stderr.
function handlePluginWorkerNotification(
  notification: PluginWorkerNotification
): void {
  if ((global as any).NX_DAEMON) {
    serverLogger.logToClient(
      ProgressTopics.GraphConstruction,
      notification.message,
      notification.level
    );
    return;
  }
  console[notification.level](notification.message);
}
