import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

const r = (p: string) => fileURLToPath(new URL(p, import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      '@harness-arena/protocol': r('./packages/protocol/src/index.ts'),
      '@harness-arena/core': r('./packages/core/src/index.ts'),
      '@harness-arena/adapters': r('./packages/adapters/src/index.ts'),
      '@harness-arena/harness': r('./packages/harness/src/index.ts'),
      '@harness-arena/evaluator': r('./packages/evaluator/src/index.ts'),
      '@harness-arena/database': r('./packages/database/src/index.ts'),
    },
  },
  test: {
    include: ['packages/*/test/**/*.test.ts', 'apps/web/test/**/*.test.ts', 'apps/web/test/**/*.test.tsx'],
    exclude: ['**/node_modules/**', '**/dist/**', '**/.next/**'],
    testTimeout: 120_000,
    hookTimeout: 120_000,
    environment: 'node',
  },
});
