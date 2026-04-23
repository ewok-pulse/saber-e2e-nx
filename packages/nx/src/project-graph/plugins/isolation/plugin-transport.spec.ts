import { EventEmitter } from 'events';
import { MessageChannel } from 'worker_threads';
import { SocketTransport, WorkerThreadTransport } from './plugin-transport';
import type { PluginWorkerMessage } from './messaging';

class FakeSocket extends EventEmitter {
  public written: Buffer[] = [];
  write(buf: any) {
    this.written.push(Buffer.isBuffer(buf) ? buf : Buffer.from(buf));
    return true;
  }
  end() {
    this.emit('end');
  }
  destroySoon() {}
}

describe('SocketTransport', () => {
  it('sends a message framed with the socket write protocol', () => {
    const socket = new FakeSocket();
    const transport = new SocketTransport(socket as any);
    const message: PluginWorkerMessage = {
      type: 'load',
      payload: {
        plugin: 'x',
        root: '/r',
        name: 'x',
        pluginPath: '/p',
        shouldRegisterTSTranspiler: false,
      },
      tx: 'x:0:load:0',
    };
    transport.send(message);
    expect(socket.written.length).toBe(2);
  });

  it('invokes onMessage handler for complete framed messages', () => {
    const socket = new FakeSocket();
    const transport = new SocketTransport(socket as any);
    const received: any[] = [];
    transport.onMessage((m) => received.push(m));

    const { serialize } = require('../../../daemon/socket-utils');
    const {
      MESSAGE_END_SEQ,
    } = require('../../../utils/consume-messages-from-socket');
    const body = Buffer.from(
      serialize({
        type: 'loadResult',
        payload: { success: true },
        tx: 'x',
      })
    );
    socket.emit('data', Buffer.concat([body, Buffer.from(MESSAGE_END_SEQ)]));
    expect(received.length).toBe(1);
    expect(received[0].type).toBe('loadResult');
  });

  it('fires onClose when socket ends', () => {
    const socket = new FakeSocket();
    const transport = new SocketTransport(socket as any);
    const closeSpy = jest.fn();
    transport.onClose(closeSpy);
    socket.emit('end');
    expect(closeSpy).toHaveBeenCalled();
  });

  it('close() ends the underlying socket', () => {
    const socket = new FakeSocket();
    const endSpy = jest.spyOn(socket, 'end');
    const transport = new SocketTransport(socket as any);
    transport.close();
    expect(endSpy).toHaveBeenCalled();
  });

  it('unsubscribes onMessage handlers', () => {
    const socket = new FakeSocket();
    const transport = new SocketTransport(socket as any);
    const received: any[] = [];
    const off = transport.onMessage((m) => received.push(m));
    off();
    const { serialize } = require('../../../daemon/socket-utils');
    const {
      MESSAGE_END_SEQ,
    } = require('../../../utils/consume-messages-from-socket');
    const body = Buffer.from(
      serialize({
        type: 'loadResult',
        payload: { success: true },
        tx: 'x',
      })
    );
    socket.emit('data', Buffer.concat([body, Buffer.from(MESSAGE_END_SEQ)]));
    expect(received.length).toBe(0);
  });
});

describe('WorkerThreadTransport', () => {
  it('round-trips a message over a MessagePort pair', async () => {
    const { port1, port2 } = new MessageChannel();
    const host = new WorkerThreadTransport(port1);
    const worker = new WorkerThreadTransport(port2);
    const received = new Promise<any>((resolve) => {
      worker.onMessage((m) => resolve(m));
    });
    host.send({
      type: 'load',
      payload: {
        plugin: 'x',
        root: '/r',
        name: 'x',
        pluginPath: '/p',
        shouldRegisterTSTranspiler: false,
      },
      tx: 't1',
    } as any);
    const m = await received;
    expect(m.type).toBe('load');
    expect(m.tx).toBe('t1');
    host.close();
    worker.close();
  });

  it('fires onClose when the peer closes', async () => {
    const { port1, port2 } = new MessageChannel();
    const host = new WorkerThreadTransport(port1);
    const worker = new WorkerThreadTransport(port2);
    const closed = new Promise<void>((resolve) =>
      host.onClose(() => resolve())
    );
    worker.close();
    await closed;
  });

  it('close() is idempotent', () => {
    const { port1 } = new MessageChannel();
    const host = new WorkerThreadTransport(port1);
    host.close();
    expect(() => host.close()).not.toThrow();
  });

  it('filters the close sentinel from onMessage handlers', async () => {
    const { port1, port2 } = new MessageChannel();
    const host = new WorkerThreadTransport(port1);
    const worker = new WorkerThreadTransport(port2);
    const received: any[] = [];
    worker.onMessage((m) => received.push(m));
    // Emulate a manual close from host — sentinel must not hit onMessage.
    host.close();
    await new Promise((resolve) => setImmediate(resolve));
    expect(received).toEqual([]);
    worker.close();
  });
});
