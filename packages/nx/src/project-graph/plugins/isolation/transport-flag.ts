export type PluginWorkerTransport = 'process' | 'threads';

let warned = false;

/**
 * Reads NX_PLUGIN_WORKER_TRANSPORT and returns 'process' (the default)
 * or 'threads'. Unknown values log a warning and fall back to 'process'.
 */
export function getPluginWorkerTransport(): PluginWorkerTransport {
  const raw = process.env.NX_PLUGIN_WORKER_TRANSPORT;
  if (raw === 'threads') return 'threads';
  if (raw === 'process' || raw === undefined || raw === '') return 'process';
  if (!warned) {
    warned = true;
    console.warn(
      `[NX] Unknown value for NX_PLUGIN_WORKER_TRANSPORT: "${raw}". ` +
        `Expected "process" or "threads". Falling back to "process".`
    );
  }
  return 'process';
}
