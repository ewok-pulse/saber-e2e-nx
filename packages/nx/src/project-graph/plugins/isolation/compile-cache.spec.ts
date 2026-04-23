import { enablePluginCompileCache } from './compile-cache';

describe('enablePluginCompileCache', () => {
  const originalFlag = process.env.NX_PLUGIN_COMPILE_CACHE;
  afterEach(() => {
    if (originalFlag === undefined) {
      delete process.env.NX_PLUGIN_COMPILE_CACHE;
    } else {
      process.env.NX_PLUGIN_COMPILE_CACHE = originalFlag;
    }
  });

  it('returns null and does not call enableImpl when flag is false', () => {
    process.env.NX_PLUGIN_COMPILE_CACHE = 'false';
    const enableImpl = jest.fn();
    const result = enablePluginCompileCache({
      enableImpl,
      getRoot: () => '/r',
    });
    expect(result).toBeNull();
    expect(enableImpl).not.toHaveBeenCalled();
  });

  it('returns null when enableImpl is not a function (pre-22.8 Node)', () => {
    delete process.env.NX_PLUGIN_COMPILE_CACHE;
    const result = enablePluginCompileCache({
      enableImpl: undefined,
      getRoot: () => '/r',
    });
    expect(result).toBeNull();
  });

  it('calls enableImpl with a path ending in /v8-cache and returns it', () => {
    delete process.env.NX_PLUGIN_COMPILE_CACHE;
    const enableImpl = jest.fn();
    const result = enablePluginCompileCache({
      enableImpl,
      getRoot: () => '/some/workspace',
    });
    expect(result).toMatch(/v8-cache$/);
    expect(enableImpl).toHaveBeenCalledWith(result);
  });

  it('returns null when enableImpl throws', () => {
    delete process.env.NX_PLUGIN_COMPILE_CACHE;
    const enableImpl = jest.fn(() => {
      throw new Error('EACCES');
    });
    const result = enablePluginCompileCache({
      enableImpl,
      getRoot: () => '/r',
    });
    expect(result).toBeNull();
  });
});
