import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/cli.ts'],
  format: ['esm'],
  target: 'node22',
  sourcemap: true,
  clean: true,
  splitting: false,
  outDir: 'dist',
});
