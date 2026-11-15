import { defineConfig } from 'vitest/config';
import * as path from 'node:path';

export default defineConfig({
  resolve: {
    alias: {
      '@dbt-docs-helper/core': path.resolve(__dirname, 'packages/core/src/index.ts'),
      vscode: path.resolve(__dirname, 'packages/vscode/test/mock/vscode.ts'),
    },
  },
  test: {
    include: ['packages/*/test/**/*.test.ts'],
    exclude: ['**/node_modules/**', 'packages/vscode/test/integration/**'],
  },
});
