import type { PluginWorkerEmitLogNotification } from './messaging';
import type { PluginTransport } from './plugin-transport';

// Plugin workers talk to their host process over a single transport that
// is established when the host connects. Plugin code running anywhere
// in the worker process needs a way to emit log lines without having
// that transport threaded through every call frame, so we stash a
// module-level reference here when the host connects.
let hostTransport: PluginTransport | null = null;

export function setPluginWorkerHostTransport(transport: PluginTransport): void {
  hostTransport = transport;
  transport.onClose(() => {
    if (hostTransport === transport) hostTransport = null;
  });
}

/**
 * Emits a log line from the plugin worker up to its host. The host
 * decides where it ends up (direct stdout/stderr when running under the
 * CLI, forwarded to the active daemon client when running under the
 * daemon).
 *
 * When plugin isolation is turned off, or this is otherwise called
 * outside of a connected plugin worker, the message is written
 * directly to stdout/stderr so the log line isn't silently dropped.
 */
export function emitPluginWorkerLog(
  level: PluginWorkerEmitLogNotification['level'],
  message: string
): void {
  if (!hostTransport) {
    console[level](message);
    return;
  }
  hostTransport.send({
    type: 'emitLog',
    level,
    message,
  });
}
