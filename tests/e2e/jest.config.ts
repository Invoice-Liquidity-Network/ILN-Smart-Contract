import type { Config } from 'jest';

const config: Config = {
  preset: 'ts-jest/presets/default-esm',
  testEnvironment: 'node',
  roots: ['<rootDir>'],
  testMatch: ['**/*.test.ts'],
  globalSetup: '<rootDir>/setup/globalSetup.ts',
  globalTeardown: '<rootDir>/setup/globalTeardown.ts',
  testTimeout: 120000,
  setupFilesAfterSetup: [],
  reporters: [
    'default',
    ['jest-allure-reporter', {
      resultsDir: 'allure-results',
      suiteTitle: true,
      ancestorSeparator: ' > ',
    }],
  ],
  transform: {
    '^.+\\.tsx?$': [
      'ts-jest',
      {
        useESM: true,
      },
    ],
  },
  moduleNameMapper: {
    '^(\\.{1,2}/.*)\\.js$': '$1',
  },
};

export default config;
