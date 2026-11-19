import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    globals: true,
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json', 'html', 'lcov'],
      include: ['src/**/*.ts'],
      exclude: ['src/index.ts', 'src/**/*.d.ts', 'dist/**'],
      lines: 95,
      functions: 95,
      branches: 95,
      statements: 95,
    },
    setupFiles: ['tests/integration/setup.ts'],
  },
});
