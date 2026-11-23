/**
 * Indexer database restore script.
 *
 * Restores a gzip-compressed backup produced by scripts/backup.ts into a
 * target SQLite database file, verifying integrity and manifest row counts
 * before swapping it into place. Restores are written to a scratch directory
 * by default so a live indexer can never be clobbered accidentally; pass
 * --force-overwrite to restore directly onto the live DB_PATH.
 *
 * Usage:
 *   tsx indexer/scripts/restore.ts --latest
 *   tsx indexer/scripts/restore.ts --file ./backups/indexer-backup-2026-08-26T07-00-00-000Z.db.gz
 *   tsx indexer/scripts/restore.ts --latest --target ./restored/indexer.db
 *
 * A snapshot that is missing tables/columns or breaks schema invariants (see
 * src/db/integrityCheck.ts) is refused before anything is installed, unless
 * --allow-incompatible is passed.
 */

import fs from 'node:fs/promises';
import { createReadStream, createWriteStream } from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { sha256File, type BackupManifest } from './backup.js';
import { checkSchemaIntegrity, findSchemaDrift } from '../src/db/integrityCheck.js';

export interface RestoreOptions {
  file?: string;
  latest?: boolean;
  target?: string;
  force?: boolean;
  /**
   * Install the snapshot even when it is missing tables/columns the current
   * indexer needs or contains rows that break schema invariants. Off by
   * default: such a snapshot passes SQLite's own integrity_check but would
   * make the indexer fail at startup or serve invalid accounting data.
   */
  allowIncompatible?: boolean;
  backupDir?: string;
}

export async function resolveLatestBackup(
  backupDir: string
): Promise<{ manifestPath: string; manifest: BackupManifest }> {
  let files: string[];
  try {
    files = await fs.readdir(backupDir);
  } catch {
    throw new Error(`Backup directory ${backupDir} does not exist.`);
  }

  const manifests = files.filter((f) => f.startsWith('indexer-backup-') && f.endsWith('.db.gz.json'));
  if (manifests.length === 0) {
    throw new Error(`No backup manifests found in ${backupDir}.`);
  }

  let best: { manifestPath: string; manifest: BackupManifest } | null = null;
  for (const name of manifests) {
    const manifestPath = path.join(backupDir, name);
    const manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8')) as BackupManifest;
    if (!best || manifest.created_at > best.manifest.created_at) {
      best = { manifestPath, manifest };
    }
  }
  return best!;
}

export async function runRestore(options: RestoreOptions = {}): Promise<string> {
  const backupDir = options.backupDir ?? (process.env.BACKUP_DIR || './backups');

  const manifestEntry = options.file
    ? {
        manifestPath: `${options.file}.json`,
        manifest: JSON.parse(await fs.readFile(`${options.file}.json`, 'utf8')) as BackupManifest,
      }
    : await resolveLatestBackup(backupDir);

  const { manifest } = manifestEntry;
  const gzPath = path.join(options.file ? path.dirname(options.file) : backupDir, manifest.file);

  console.log(`Restoring backup: ${manifest.file}`);
  console.log(`  created_at:        ${manifest.created_at}`);
  console.log(`  checkpoint ledger: ${manifest.last_processed_ledger ?? 'unknown'}`);

  // Verify checksum before touching the target location.
  const actualSha = await sha256File(gzPath);
  if (actualSha !== manifest.sha256) {
    throw new Error(
      `Checksum mismatch for ${manifest.file}: expected ${manifest.sha256}, got ${actualSha}. Backup media may be corrupted.`
    );
  }
  console.log(`  checksum verified: ${actualSha.slice(0, 16)}...`);

  const target = options.target || process.env.RESTORE_DB_PATH || path.join('./restored', 'indexer.db');
  const targetDir = path.dirname(target);
  await fs.mkdir(targetDir, { recursive: true });

  if (!options.force && (await fileExists(target))) {
    throw new Error(
      `Target ${target} already exists. Use --force-overwrite or choose another --target to avoid clobbering a live database.`
    );
  }

  // Decompress to a temp file and run an integrity check before installing it.
  const tmpRestore = `${target}.restore-tmp-${Date.now()}`;
  try {
    const { pipeline } = await import('node:stream/promises');
    const { createGunzip } = await import('node:zlib');
    await pipeline(createReadStream(gzPath), createGunzip(), createWriteStream(tmpRestore));

    const db = new Database(tmpRestore);
    try {
      const integrity = (db.pragma('integrity_check', { simple: true }) as string) || 'unknown';
      if (integrity !== 'ok') {
        throw new Error(`Restored snapshot failed integrity check: ${integrity}`);
      }
      console.log('  integrity_check:   ok');

      const counts = db
        .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name`)
        .all() as Array<{ name: string }>;
      for (const { name } of counts) {
        const n = (db.prepare(`SELECT COUNT(*) AS n FROM "${name}"`).get() as { n: number }).n;
        const expected = manifest.table_counts?.[name];
        if (expected !== undefined && expected !== n) {
          throw new Error(
            `Row count mismatch for table ${name}: manifest says ${expected}, restored file has ${n}.`
          );
        }
        console.log(`    ${name}: ${n} row(s)`);
      }

      // Schema compatibility: integrity_check and row counts say nothing about
      // whether the snapshot matches the schema this indexer version expects.
      // Drift is checked first because the row-level checks need the tables.
      const drift = findSchemaDrift(db);
      const driftErrors = drift.filter((v) => v.severity === 'error');
      const rowViolations = driftErrors.length === 0 ? checkSchemaIntegrity(db) : [];
      const violations = [...drift, ...rowViolations];
      for (const v of violations.filter((x) => x.severity === 'warning')) {
        console.warn(`  warning: ${v.detail}`);
      }
      const blocking = violations.filter((v) => v.severity === 'error');
      if (blocking.length > 0) {
        const summary = blocking.map((v) => v.detail).join('; ');
        if (!options.allowIncompatible) {
          throw new Error(
            `Restored snapshot is incompatible with the current indexer schema (${blocking.length} problem(s)): ${summary}. ` +
              `Nothing was installed. Use --allow-incompatible to override.`
          );
        }
        console.warn(`  --allow-incompatible: installing despite ${blocking.length} problem(s): ${summary}`);
      } else {
        console.log('  schema check:      ok');
      }

      // An old-shape snapshot installed with --allow-incompatible has no checkpoint table.
      const ledgerRow = counts.some((t) => t.name === 'indexer_state')
        ? (db
            .prepare(`SELECT state_value FROM indexer_state WHERE state_key = 'last_processed_ledger'`)
            .get() as { state_value: string } | undefined)
        : undefined;
      console.log(`  restored checkpoint ledger: ${ledgerRow?.state_value ?? 'none recorded'}`);
    } finally {
      db.close();
    }

    await fs.rm(target, { force: true });
    await fs.rename(tmpRestore, target);
  } catch (error) {
    await fs.rm(tmpRestore, { force: true });
    throw error;
  }

  console.log(`Restore complete: ${target}`);
  console.log('Next steps:');
  console.log(`  1. Point the indexer/API at this file (DB_PATH=${target}).`);
  console.log(`  2. Run: tsx indexer/scripts/verify-restore.ts --db ${target}`);
  console.log('  3. Resume ingestion — the listener continues from the restored cursor.');

  return target;
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

function parseArgs(argv: string[]): RestoreOptions {
  const args: RestoreOptions = {};
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--latest') args.latest = true;
    else if (argv[i] === '--force-overwrite') args.force = true;
    else if (argv[i] === '--allow-incompatible') args.allowIncompatible = true;
    else if (argv[i] === '--file') { i += 1; args.file = argv[i]; }
    else if (argv[i] === '--target') { i += 1; args.target = argv[i]; }
  }
  return args;
}

const invokedDirectly = process.argv[1] && process.argv[1].endsWith('restore.ts');
if (invokedDirectly) {
  void runRestore(parseArgs(process.argv.slice(2))).catch((error) => {
    console.error(`Restore failed: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  });
}
