import type { Socket } from 'net';
import type { MessagePort } from 'worker_threads';
import { serialize } from '../../../daemon/socket-utils';
import {
  consumeMessagesFromSocket,
  MESSAGE_END_SEQ,
  parseMessage,
} from '../../../utils/consume-messages-from-socket';
import type {
  PluginWorkerMessage,
  PluginWorkerNotification,
  PluginWorkerResult,
} from './messaging';

/**
 * Any message that can travel over the plugin transport in either direction.
 */
export type PluginTransportMessage =
  | PluginWorkerMessage
  | PluginWorkerResult
  | PluginWorkerNotification;

/**
 * Abstracts the host<->worker channel. Two implementations:
 *   - SocketTransport      : net.Socket + v8/JSON framing (child_process path)
 *   - WorkerThreadTransport: MessagePort structured clone  (worker_threads path)
 *
 * Message ordering is preserved per-direction. The transport is not
 * responsible for request/response correlation — that lives in IsolatedPlugin
 * via the tx-keyed handler map.
 */
export interface PluginTransport {
  send(message: PluginTransportMessage): void;
  onMessage(handler: (message: PluginTransportMessage) => void): () => void;
  onClose(handler: () => void): () => void;
  close(): void;
}

export class SocketTransport implements PluginTransport {
  private readonly messageHandlers = new Set<
    (m: PluginTransportMessage) => void
  >();
  private readonly closeHandlers = new Set<() => void>();
  private closed = false;

  constructor(private readonly socket: Socket) {
    socket.on(
      'data',
      consumeMessagesFromSocket((raw) => {
        const message = parseMessage<PluginTransportMessage>(raw);
        for (const handler of this.messageHandlers) {
          handler(message);
        }
      })
    );
    const fireClose = () => {
      if (this.closed) return;
      this.closed = true;
      for (const handler of this.closeHandlers) {
        handler();
      }
    };
    socket.on('end', fireClose);
    socket.on('close', fireClose);
  }

  send(message: PluginTransportMessage): void {
    this.socket.write(serialize(message));
    this.socket.write(MESSAGE_END_SEQ);
  }

  onMessage(handler: (m: PluginTransportMessage) => void): () => void {
    this.messageHandlers.add(handler);
    return () => {
      this.messageHandlers.delete(handler);
    };
  }

  onClose(handler: () => void): () => void {
    this.closeHandlers.add(handler);
    return () => {
      this.closeHandlers.delete(handler);
    };
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.socket.end();
  }
}

const THREAD_CLOSE_SENTINEL = '__nx_plugin_transport_close__' as const;

interface ThreadCloseSentinelMessage {
  [THREAD_CLOSE_SENTINEL]: true;
}

function isCloseSentinel(
  message: unknown
): message is ThreadCloseSentinelMessage {
  return (
    !!message &&
    typeof message === 'object' &&
    (message as Record<string, unknown>)[THREAD_CLOSE_SENTINEL] === true
  );
}

export class WorkerThreadTransport implements PluginTransport {
  private readonly messageHandlers = new Set<
    (m: PluginTransportMessage) => void
  >();
  private readonly closeHandlers = new Set<() => void>();
  private closed = false;

  constructor(private readonly port: MessagePort) {
    port.on('message', (message: unknown) => {
      if (isCloseSentinel(message)) {
        this.handleClose();
        return;
      }
      for (const handler of this.messageHandlers) {
        handler(message as PluginTransportMessage);
      }
    });
    port.on('close', () => this.handleClose());
  }

  send(message: PluginTransportMessage): void {
    if (this.closed) return;
    this.port.postMessage(message);
  }

  onMessage(handler: (m: PluginTransportMessage) => void): () => void {
    this.messageHandlers.add(handler);
    return () => {
      this.messageHandlers.delete(handler);
    };
  }

  onClose(handler: () => void): () => void {
    this.closeHandlers.add(handler);
    return () => {
      this.closeHandlers.delete(handler);
    };
  }

  close(): void {
    if (this.closed) return;
    try {
      this.port.postMessage({ [THREAD_CLOSE_SENTINEL]: true });
    } catch {
      // Peer may already be gone; ignore.
    }
    this.handleClose();
    try {
      this.port.close();
    } catch {
      // close() can throw on an already-closed port in some Node versions.
    }
  }

  private handleClose(): void {
    if (this.closed) return;
    this.closed = true;
    for (const handler of this.closeHandlers) {
      handler();
    }
  }
}
