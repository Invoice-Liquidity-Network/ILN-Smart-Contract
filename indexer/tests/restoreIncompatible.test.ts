import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { gzipSync } from 'node:zlib';
import Database from 'better-sqlite3';
import { initializeSchema } from '../src/db/schema.js';
import { createBackup, sha256File, type BackupManifest } from '../scripts/backup.js';
import { runRestore } from '../scripts/restore.js';

/**
 * Backup and restore must fail safely on incompatible data: a bad snapshot is
 * refused before anything is installed, an existing target is left untouched,
 * and no temp files are left behind.
 */

let tmpDir: string;
let backupDir: string;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'iln-indexer-incompat-'));
  backupDir = path.join(tmpDir, 'backups');
  await fs.mkdir(backupDir, { recursive: true });
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
});

afterEach(async () => {
  vi.restoreAllMocks();
  await fs.rm(tmpDir, { recursive: true, force: true });
});

const NOW = 1_800_000_000;

function insertInvoice(db: Database.Database, id: number, amount = '1000'): void {
  db.prepare(
    `INSERT INTO invoices (id, freelancer, payer, token, amount, due_date, discount_rate, created_at)
     VALUES (?, 'GFL', 'GPAYER', 'USDC', ?, ?, 300, ?)`
  ).run(id, amount, NOW + 1000, NOW);
}

/** Build a source database at `name`, let `setup` shape it, and back it up. */
async function backupOf(name: string, setup: (db: Database.Database) => void): Promise<{ gz: string; manifest: BackupManifest }> {
  const dbPath = path.join(tmpDir, name);
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  try {
    setup(db);
  } finally {
    db.close();
  }
  const manifest = await createBackup({ dbPath, backupDir, now: new Date(Date.UTC(2026, 0, 1, 0, 0, backupSeq++)) });
  return { gz: path.join(backupDir, manifest.file), manifest };
}
let backupSeq = 0;

const exists = (p: string) => fs.access(p).then(() => true, () => false);

async function expectNoRestoreTemp(target: string): Promise<void> {
  const siblings = await fs.readdir(path.dirname(target)).catch(() => [] as string[]);
  expect(siblings.filter((f) => f.includes('.restore-tmp-'))).toEqual([]);
}

/** A database from before the ingestion metadata columns and indexer_state existed. */
function createOldShapeDb(db: Database.Database): void {
  db.exec(`
    CREATE TABLE invoices (
      id INTEGER PRIMARY KEY, freelancer TEXT NOT NULL, payer TEXT NOT NULL, token TEXT NOT NULL,
      amount TEXT NOT NULL, due_date INTEGER NOT NULL, discount_rate INTEGER NOT NULL,
      status TEXT NOT NULL DEFAULT 'Pending', funder TEXT, funded_at INTEGER,
      amount_funded TEXT NOT NULL DEFAULT '0', amount_paid TEXT NOT NULL DEFAULT '0',
      referral_code TEXT, submitter_reputation INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL
    );
    CREATE TABLE events (
      id INTEGER PRIMARY KEY AUTOINCREMENT, invoice_id INTEGER NOT NULL, event_type TEXT NOT NULL,
      ledger INTEGER NOT NULL, timestamp INTEGER NOT NULL, data TEXT NOT NULL DEFAULT '{}',
      FOREIGN KEY (invoice_id) REFERENCES invoices(id)
    );
  `);
  insertInvoice(db, 1);
}

describe('backup of an incompatible database', () => {
  it('records an unknown checkpoint instead of failing when indexer_state is missing', async () => {
    const { manifest } = await backupOf('old.db', createOldShapeDb);
    expect(manifest.last_processed_ledger).toBeNull();
    expect(manifest.last_processed_cursor).toBeNull();
    expect(manifest.table_counts.invoices).toBe(1);
  });

  it('leaves no temp snapshot, archive or manifest when the source is not a SQLite database', async () => {
    const dbPath = path.join(tmpDir, 'garbage.db');
    await fs.writeFile(dbPath, 'this is not a sqlite database '.repeat(50));

    await expect(createBackup({ dbPath, backupDir })).rejects.toThrow();
    expect(await fs.readdir(backupDir)).toEqual([]);
  });
});

describe('restore refuses an incompatible snapshot before installing it', () => {
  it('refuses a snapshot missing columns/tables the current indexer needs, and names them', async () => {
    const { gz } = await backupOf('old.db', createOldShapeDb);
    const target = path.join(tmpDir, 'restored', 'indexer.db');

    await expect(runRestore({ file: gz, target, backupDir })).rejects.toThrow(
      /incompatible with the current indexer schema[\s\S]*events\.transaction_hash[\s\S]*Nothing was installed/
    );
    expect(await exists(target)).toBe(false);
    await expectNoRestoreTemp(target);
  });

  it('refuses a snapshot containing rows that break accounting invariants', async () => {
    const { gz } = await backupOf('bad-amount.db', (db) => {
      initializeSchema(db);
      insertInvoice(db, 1, '-5');
      insertInvoice(db, 2, '1.5');
    });
    const target = path.join(tmpDir, 'restored', 'indexer.db');

    await expect(runRestore({ file: gz, target, backupDir })).rejects.toThrow(
      /invoices\.amount that is not a non-negative integer string/
    );
    expect(await exists(target)).toBe(false);
  });

  it('refuses a snapshot with orphan events (written while foreign_keys was off)', async () => {
    const { gz } = await backupOf('orphans.db', (db) => {
      initializeSchema(db);
      db.pragma('foreign_keys = OFF');
      db.prepare(`INSERT INTO events (invoice_id, event_type, ledger, timestamp) VALUES (999, 'x', 1, 1)`).run();
    });
    const target = path.join(tmpDir, 'restored', 'indexer.db');

    await expect(runRestore({ file: gz, target, backupDir })).rejects.toThrow(/reference a missing invoices row/);
    expect(await exists(target)).toBe(false);
  });

  it('leaves an existing target untouched when --force-overwrite meets an incompatible snapshot', async () => {
    const { gz } = await backupOf('old.db', createOldShapeDb);
    const target = path.join(tmpDir, 'live.db');
    const liveDb = new Database(target);
    initializeSchema(liveDb);
    insertInvoice(liveDb, 42);
    liveDb.close();
    const before = await sha256File(target);

    await expect(runRestore({ file: gz, target, force: true, backupDir })).rejects.toThrow(/incompatible/);

    expect(await sha256File(target)).toBe(before);
    await expectNoRestoreTemp(target);
  });

  it('installs an incompatible snapshot only with allowIncompatible, and says so', async () => {
    const { gz } = await backupOf('old.db', createOldShapeDb);
    const target = path.join(tmpDir, 'restored', 'indexer.db');

    await expect(runRestore({ file: gz, target, backupDir, allowIncompatible: true })).resolves.toBe(target);
    expect(await exists(target)).toBe(true);
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining('--allow-incompatible'));
  });

  it('still restores a compatible snapshot that only has legacy rows without dedupe keys (warning, not error)', async () => {
    const { gz } = await backupOf('legacy-rows.db', (db) => {
      initializeSchema(db);
      insertInvoice(db, 1);
      db.prepare(`INSERT INTO events (invoice_id, event_type, ledger, timestamp) VALUES (1, 'submitted', 1, 1)`).run();
    });
    const target = path.join(tmpDir, 'restored', 'indexer.db');

    await expect(runRestore({ file: gz, target, backupDir })).resolves.toBe(target);
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining('dedupe'));
  });
});

describe('restore refuses damaged archives and manifests', () => {
  /** Write a gz + manifest pair for arbitrary bytes, as a damaged backup would look. */
  async function craft(bytes: Buffer, tableCounts: Record<string, number> = {}): Promise<string> {
    const file = 'indexer-backup-2026-01-02T00-00-00-000Z.db.gz';
    const gz = path.join(backupDir, file);
    await fs.writeFile(gz, gzipSync(bytes));
    const manifest: BackupManifest = {
      file,
      sha256: await sha256File(gz),
      sizeBytes: (await fs.stat(gz)).size,
      created_at: '2026-01-02T00:00:00.000Z',
      source_db_path: '/x',
      last_processed_ledger: null,
      last_processed_cursor: null,
      table_counts: tableCounts,
    };
    await fs.writeFile(`${gz}.json`, JSON.stringify(manifest));
    return gz;
  }

  it('refuses an archive with a valid checksum whose contents are not a SQLite database', async () => {
    const gz = await craft(Buffer.from('definitely not sqlite '.repeat(100)));
    const target = path.join(tmpDir, 'restored', 'indexer.db');

    await expect(runRestore({ file: gz, target, backupDir })).rejects.toThrow(/not a database|malformed|encrypted/i);
    expect(await exists(target)).toBe(false);
    await expectNoRestoreTemp(target);
  });

  it('refuses a snapshot whose row counts disagree with its manifest', async () => {
    const { gz } = await backupOf('counts.db', (db) => {
      initializeSchema(db);
      insertInvoice(db, 1);
    });
    const manifestPath = `${gz}.json`;
    const manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8')) as BackupManifest;
    manifest.table_counts.invoices = 5;
    await fs.writeFile(manifestPath, JSON.stringify(manifest));
    const target = path.join(tmpDir, 'restored', 'indexer.db');

    await expect(runRestore({ file: gz, target, backupDir })).rejects.toThrow(/Row count mismatch for table invoices/);
    expect(await exists(target)).toBe(false);
    await expectNoRestoreTemp(target);
  });

  it('refuses a truncated archive even when the manifest checksum was recomputed over it', async () => {
    const { gz, manifest } = await backupOf('trunc.db', (db) => {
      initializeSchema(db);
      insertInvoice(db, 1);
    });
    const raw = await fs.readFile(gz);
    await fs.writeFile(gz, raw.subarray(0, Math.floor(raw.length / 2)));
    manifest.sha256 = await sha256File(gz);
    await fs.writeFile(`${gz}.json`, JSON.stringify(manifest));
    const target = path.join(tmpDir, 'restored', 'indexer.db');

    await expect(runRestore({ file: gz, target, backupDir })).rejects.toThrow();
    expect(await exists(target)).toBe(false);
    await expectNoRestoreTemp(target);
  });
});
