import { getPluginWorkerTransport } from './transport-flag';

describe('getPluginWorkerTransport', () => {
  const originalEnv = process.env.NX_PLUGIN_WORKER_TRANSPORT;

  afterEach(() => {
    if (originalEnv === undefined) {
      delete process.env.NX_PLUGIN_WORKER_TRANSPORT;
    } else {
      process.env.NX_PLUGIN_WORKER_TRANSPORT = originalEnv;
    }
    jest.isolateModules(() => {
      // Reset the module's internal warned flag between tests.
      require('./transport-flag');
    });
  });

  it('defaults to "process" when unset', () => {
    delete process.env.NX_PLUGIN_WORKER_TRANSPORT;
    expect(getPluginWorkerTransport()).toBe('process');
  });

  it('returns "threads" when env is set to threads', () => {
    process.env.NX_PLUGIN_WORKER_TRANSPORT = 'threads';
    expect(getPluginWorkerTransport()).toBe('threads');
  });

  it('returns "process" when env is explicitly set to process', () => {
    process.env.NX_PLUGIN_WORKER_TRANSPORT = 'process';
    expect(getPluginWorkerTransport()).toBe('process');
  });

  it('returns "process" and warns once for unknown values', () => {
    jest.isolateModules(() => {
      const { getPluginWorkerTransport: fresh } = require('./transport-flag');
      process.env.NX_PLUGIN_WORKER_TRANSPORT = 'rockets';
      const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
      expect(fresh()).toBe('process');
      expect(fresh()).toBe('process');
      expect(warn).toHaveBeenCalledTimes(1);
      warn.mockRestore();
    });
  });
});
