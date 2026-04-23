// Minimal NxPluginV2 used by thread-round-trip.spec.ts.
module.exports = {
  name: 'echo-plugin',
  createNodesV2: [
    '**/*.echo.json',
    async (files) =>
      files.map((file) => [file, { projects: { [file]: { root: file } } }]),
  ],
};
