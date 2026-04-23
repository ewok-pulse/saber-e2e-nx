import { IsolatedPlugin } from '../isolated-plugin';

describe('IsolatedPlugin (threads)', () => {
  const originalEnv = process.env.NX_PLUGIN_WORKER_TRANSPORT;

  beforeEach(() => {
    process.env.NX_PLUGIN_WORKER_TRANSPORT = 'threads';
  });

  afterEach(() => {
    if (originalEnv === undefined) {
      delete process.env.NX_PLUGIN_WORKER_TRANSPORT;
    } else {
      process.env.NX_PLUGIN_WORKER_TRANSPORT = originalEnv;
    }
  });

  it('loads a plugin over worker_threads and runs createNodes', async () => {
    const pluginPath = require.resolve('./fixtures/echo-plugin.js');
    const plugin = await IsolatedPlugin.load(pluginPath, process.cwd());
    try {
      expect(plugin.name).toBe('echo-plugin');
      const [, fn] = plugin.createNodes!;
      const result = await fn(['a.echo.json'], {
        nxJsonConfiguration: {} as any,
        workspaceRoot: process.cwd(),
      } as any);
      expect(result).toEqual([
        [
          'echo-plugin',
          'a.echo.json',
          { projects: { 'a.echo.json': { root: 'a.echo.json' } } },
        ],
      ]);
    } finally {
      plugin.shutdown();
    }
  }, 30_000);
});
