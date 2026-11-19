import { afterEach, describe, expect, it } from 'vitest';
import { existsSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { createNotificationsDatabase } from '../src/database';

describe('createNotificationsDatabase', () => {
  afterEach(() => {
    // no-op; each test handles its own cleanup
  });

  it('configures in-memory databases with WAL and foreign keys', () => {
    const db = createNotificationsDatabase(':memory:');
    expect(db.pragma('foreign_keys', { simple: true })).toBe(1);
    db.close();
  });

  it('creates the target directory for file-backed databases', () => {
    const root = mkdtempSync(join(tmpdir(), 'iln-notifications-db-'));
    const dbPath = join(root, 'nested', 'notifications.db');

    const db = createNotificationsDatabase(dbPath);
    expect(existsSync(dirname(dbPath))).toBe(true);
    expect(db.pragma('journal_mode', { simple: true })).toBe('wal');
    db.close();

    rmSync(root, { recursive: true, force: true });
  });
});
