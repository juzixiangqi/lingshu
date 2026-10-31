import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const fromRoot = (relativePath: string): string =>
  fileURLToPath(new URL(relativePath, import.meta.url));

export default defineConfig({
  resolve: {
    alias: [
      // 测试与覆盖率都指向 TypeScript 源码，避免依赖 packages/shared 的 dist 产物。
      {
        find: /^@lingshu\/shared$/,
        replacement: fromRoot('./packages/shared/src/index.ts'),
      },
    ],
  },
  test: {
    environment: 'node',
    // 所有测试文件串行执行，避免并行写同一个测试库。
    fileParallelism: false,
    setupFiles: ['./test/setup.ts'],
    testTimeout: 30_000,
    hookTimeout: 60_000,
    include: [
      'packages/shared/src/**/*.test.ts',
      'apps/api/src/**/*.test.ts',
      'apps/collab/src/**/*.test.ts',
      'apps/web/src/lib/**/*.test.ts',
    ],
    exclude: ['**/node_modules/**', '**/dist/**'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json-summary'],
      reportsDirectory: 'coverage',
      include: [
        'packages/shared/src/**/*.ts',
        'apps/api/src/**/*.ts',
        'apps/collab/src/**/*.ts',
        'apps/web/src/lib/collab.ts',
      ],
      exclude: [
        '**/*.test.ts',
        '**/src/test/**',
        '**/index.ts',
        'apps/api/src/scripts/db-init.ts',
      ],
      thresholds: {
        lines: 80,
        statements: 80,
        functions: 80,
        branches: 75,
      },
    },
  },
});
