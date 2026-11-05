import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  type DatabaseConnection,
  type DatabaseTarget,
  databaseProcessEnvironment,
} from './database-target.ts';

export type Command = { file: string; args: string[]; env: NodeJS.ProcessEnv; cwd: string };
export type CommandRunner = (command: Command) => Promise<string>;
export type BackupReceipt = {
  version: 1;
  target: string;
  file: string;
  sha256: string;
  createdAt: string;
};
export type MaintenanceOptions = {
  root: string;
  env: NodeJS.ProcessEnv;
  target: DatabaseTarget;
  run?: CommandRunner;
};

export const runDatabaseCommand: CommandRunner = (command) =>
  new Promise((resolve, reject) => {
    const child = spawn(command.file, command.args, {
      cwd: command.cwd,
      env: command.env,
      shell: false,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    const timeout = setTimeout(() => {
      child.kill();
      reject(new Error('DATABASE_COMMAND_TIMEOUT'));
    }, 600_000);
    child.stdout.on('data', (data: Buffer) => {
      output += data.toString();
      if (output.length > 16_000_000) {
        child.kill();
        reject(new Error('DATABASE_COMMAND_OUTPUT_LIMIT'));
      }
    });
    child.stderr.resume();
    child.on('error', () => {
      clearTimeout(timeout);
      reject(new Error('DATABASE_COMMAND_FAILED'));
    });
    child.on('close', (code) => {
      clearTimeout(timeout);
      if (code === 0) resolve(output);
      else reject(new Error('DATABASE_COMMAND_FAILED'));
    });
  });

function sha256(value: string | Buffer): string {
  return createHash('sha256').update(value).digest('hex');
}

async function command(
  options: MaintenanceOptions,
  connection: DatabaseConnection,
  name: string,
  args: string[],
): Promise<string> {
  const file = options.env.PG_BIN_DIR
    ? join(options.env.PG_BIN_DIR, `${name}${process.platform === 'win32' ? '.exe' : ''}`)
    : name;
  try {
    return await (options.run ?? runDatabaseCommand)({
      file,
      args,
      env: databaseProcessEnvironment(connection, options.env),
      cwd: options.root,
    });
  } catch {
    throw new Error(`DATABASE_${name.toUpperCase()}_FAILED`);
  }
}

async function identity(
  options: MaintenanceOptions,
  connection: DatabaseConnection,
): Promise<{ journal: boolean }> {
  const output = await command(options, connection, 'psql', [
    '-X',
    '-A',
    '-t',
    '-v',
    'ON_ERROR_STOP=1',
    '-c',
    "SELECT json_build_object('database', current_database(), 'user', current_user, 'journal', to_regclass('drizzle.__drizzle_migrations') IS NOT NULL)",
  ]);
  const value = JSON.parse(output) as { database?: string; user?: string; journal: boolean };
  const role =
    connection.host.endsWith('.pooler.supabase.com') && connection.project
      ? connection.user.slice(0, -(connection.project.length + 1))
      : connection.user;
  if (value.database !== connection.database || value.user !== role)
    throw new Error('DATABASE_IDENTITY_MISMATCH');
  return value;
}

export async function createVerifiedBackup(options: MaintenanceOptions): Promise<BackupReceipt> {
  await identity(options, options.target.backup);
  const directory = join(options.root, 'scratch/database-maintenance', options.target.fingerprint);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const file = join(
    directory,
    `${new Date().toISOString().replaceAll(':', '-')}-${randomUUID()}.dump`,
  );
  await command(options, options.target.backup, 'pg_dump', ['--format=custom', '--file', file]);
  if (!(await stat(file)).size) throw new Error('DATABASE_BACKUP_EMPTY');
  await command(options, options.target.backup, 'pg_restore', ['--list', file]);
  const receipt: BackupReceipt = {
    version: 1,
    target: options.target.fingerprint,
    file,
    sha256: sha256(await readFile(file)),
    createdAt: new Date().toISOString(),
  };
  await writeFile(`${file}.json`, `${JSON.stringify(receipt, null, 2)}\n`, {
    flag: 'wx',
    mode: 0o600,
  });
  return receipt;
}

export async function verifyBackupReceipt(
  receipt: BackupReceipt,
  target: Pick<DatabaseTarget, 'fingerprint'>,
): Promise<void> {
  if (
    receipt.version !== 1 ||
    receipt.target !== target.fingerprint ||
    receipt.sha256 !== sha256(await readFile(receipt.file))
  )
    throw new Error('DATABASE_BACKUP_RECEIPT_INVALID');
}

async function inspect(options: MaintenanceOptions) {
  const metadata = await identity(options, options.target.migration);
  if (!metadata.journal) throw new Error('DATABASE_HISTORY_REVIEW_REQUIRED');
  const directory = join(options.root, 'packages/db/drizzle');
  const journalSource = await readFile(join(directory, 'meta/_journal.json'), 'utf8');
  const local = JSON.parse(journalSource) as {
    entries?: { idx: number; tag: string; when: number }[];
  } | null;
  if (!Array.isArray(local?.entries)) throw new Error('DATABASE_HISTORY_REVIEW_REQUIRED');
  const tags = new Set<string>();
  let previousTimestamp = 0;
  for (const [index, entry] of local.entries.entries()) {
    if (
      !entry ||
      entry.idx !== index ||
      typeof entry.tag !== 'string' ||
      !/^[a-zA-Z0-9_-]+$/.test(entry.tag) ||
      tags.has(entry.tag) ||
      !Number.isSafeInteger(entry.when) ||
      entry.when <= previousTimestamp
    )
      throw new Error('DATABASE_HISTORY_REVIEW_REQUIRED');
    tags.add(entry.tag);
    previousTimestamp = entry.when;
  }
  const applied = JSON.parse(
    await command(options, options.target.migration, 'psql', [
      '-X',
      '-A',
      '-t',
      '-v',
      'ON_ERROR_STOP=1',
      '-c',
      "SELECT coalesce(json_agg(j ORDER BY created_at), '[]') FROM (SELECT hash, created_at::text FROM drizzle.__drizzle_migrations) j",
    ]),
  ) as { hash: string; created_at: string }[];
  // The first nine journal entries cross manual hardening steps; automatic bootstrap is unsafe.
  if (applied.length < 9 || applied.length > local.entries.length)
    throw new Error('DATABASE_HISTORY_REVIEW_REQUIRED');
  for (const [index, entry] of applied.entries()) {
    const expected = local.entries[index];
    if (
      entry.created_at !== String(expected.when) ||
      entry.hash !== sha256(await readFile(join(directory, `${expected.tag}.sql`)))
    )
      throw new Error('DATABASE_HISTORY_REVIEW_REQUIRED');
  }
  const files = [
    ...(await readdir(directory)).filter(
      (file) => file.endsWith('.sql') || file === 'MIGRATION-ORDER.md',
    ),
    'meta/_journal.json',
  ].sort();
  const history = await Promise.all(
    files.map(async (file) => [
      file,
      sha256(file === 'meta/_journal.json' ? journalSource : await readFile(join(directory, file))),
    ]),
  );
  const schema = await command(options, options.target.backup, 'pg_dump', [
    '--schema-only',
    '--no-owner',
  ]);
  const stableSchema = schema
    .replaceAll('\r\n', '\n')
    .split('\n')
    .filter(
      (line) =>
        !line.startsWith('\\restrict ') &&
        !line.startsWith('\\unrestrict ') &&
        !line.startsWith('-- Dumped'),
    )
    .join('\n');
  return {
    version: 1,
    target: options.target.fingerprint,
    schemaSha256: sha256(stableSchema),
    historySha256: sha256(JSON.stringify(history)),
    journal: applied,
    reviewed: false,
  };
}

export async function maintainDatabase(
  options: MaintenanceOptions & {
    mode: 'backup' | 'migrate' | 'inspect';
    dryRun?: boolean;
    apply?: boolean;
    confirmTarget?: string;
    baseline?: string;
  },
): Promise<unknown> {
  if (options.dryRun || (options.mode === 'migrate' && !options.apply))
    return {
      status: 'preview',
      target: options.target.fingerprint,
      label: options.target.label,
      steps:
        options.mode === 'backup'
          ? ['verify identity', 'dump', 'verify archive', 'checksum receipt']
          : ['verify reviewed baseline and journal', 'verified backup', 'Drizzle migration'],
    };
  if (options.mode === 'backup') return createVerifiedBackup(options);
  if (options.mode === 'inspect') return inspect(options);
  if (options.confirmTarget !== options.target.fingerprint)
    throw new Error('DATABASE_TARGET_CONFIRMATION_REQUIRED');
  if (!options.baseline) throw new Error('DATABASE_BASELINE_REQUIRED');
  const baseline = JSON.parse(await readFile(options.baseline, 'utf8')) as Record<string, unknown>;
  const current = await inspect(options);
  if (
    baseline.reviewed !== true ||
    typeof baseline.reviewedBy !== 'string' ||
    !baseline.reviewedBy.trim() ||
    baseline.version !== current.version ||
    baseline.target !== current.target ||
    baseline.schemaSha256 !== current.schemaSha256 ||
    baseline.historySha256 !== current.historySha256 ||
    JSON.stringify(baseline.journal) !== JSON.stringify(current.journal)
  )
    throw new Error('DATABASE_BASELINE_MISMATCH');
  const backup = await createVerifiedBackup(options);
  await verifyBackupReceipt(backup, options.target);
  try {
    await (options.run ?? runDatabaseCommand)({
      file: process.execPath,
      args: [join(options.root, 'packages/db/node_modules/drizzle-kit/bin.cjs'), 'migrate'],
      cwd: join(options.root, 'packages/db'),
      env: databaseProcessEnvironment(options.target.migration, options.env),
    });
  } catch {
    throw new Error('DATABASE_MIGRATION_FAILED: backup retained; inspect state before retry');
  }
  return { status: 'applied', target: options.target.fingerprint, backup };
}
