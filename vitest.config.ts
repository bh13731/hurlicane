import { defineConfig } from 'vitest/config';
import path from 'path';

export default defineConfig({
  resolve: {
    alias: {
      '@shared': path.resolve(__dirname, 'src/shared'),
    },
  },
  test: {
    globals: true,
    environment: 'node',
    include: ['src/test/**/*.test.ts', 'src/test/**/*.test.tsx'],
    // Each test file gets a fresh module graph so singleton state doesn't leak
    isolate: true,
    // node:sqlite requires this flag (vitest v4 top-level config)
    execArgv: ['--experimental-sqlite'],
    coverage: {
      provider: 'v8',
      include: ['src/client/**/*.{ts,tsx}'],
      exclude: [
        'src/client/main.tsx',
        'src/client/index.html',
        'src/client/css-modules.d.ts',
        'src/client/styles/**',
      ],
      reporter: ['text', 'text-summary', 'html'],
      thresholds: {
        statements: 20,
        branches: 15,
        functions: 15,
        lines: 20,
      },
    },
  },
});
