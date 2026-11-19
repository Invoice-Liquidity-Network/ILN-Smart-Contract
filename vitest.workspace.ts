import { defineWorkspace } from 'vitest/config';

export default defineWorkspace([
  'sdk',
  'cli',
  'indexer',
  'notifications',
  'packages/*'
]);
