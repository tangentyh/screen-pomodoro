import { defineConfig } from 'tsdown';

export default defineConfig({
  entry: ['src/cli.ts'],
  format: ['esm'],
  target: 'node22',
  sourcemap: true,
  clean: true,
  outDir: 'dist',
  // Keep the historical output path that package.json `bin` points to
  // (tsdown defaults ESM to `.mjs`; tsup emitted `.js`).
  outExtensions: () => ({ js: '.js' }),
});
