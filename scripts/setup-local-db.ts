import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createVerifiedBackup } from './lib/database-maintenance.ts';
import { databaseProcessEnvironment, resolveDatabaseTarget } from './lib/database-target.ts';

// Bootstrap only an empty, explicitly selected local database. Existing databases
// continue to use the reviewed migration workflow and its baseline checks.
async function main() {
  if (process.argv.slice(2).join(' ') !== '--confirm')
    throw new Error('LOCAL_SETUP_CONFIRM_REQUIRED');
  const root = process.cwd();
  if (!process.env.DATABASE_URL) throw new Error('LOCAL_SETUP_DATABASE_URL_REQUIRED');
  const target = resolveDatabaseTarget(process.env);
  if (
    !['localhost', '127.0.0.1', '[::1]', '::1'].includes(target.migration.host) ||
    target.backup.url !== target.migration.url
  )
    throw new Error('LOCAL_SETUP_LOCAL_DIRECT_DATABASE_REQUIRED');
  const runtime = new URL(process.env.APP_DATABASE_URL ?? '');
  const admin = new URL(target.migration.url);
  if (
    runtime.protocol !== admin.protocol ||
    runtime.hostname !== admin.hostname ||
    runtime.port !== admin.port ||
    runtime.pathname !== admin.pathname ||
    runtime.username !== 'app_user' ||
    !runtime.password
  )
    throw new Error('LOCAL_SETUP_MATCHING_APP_USER_REQUIRED');
  const env = databaseProcessEnvironment(target.migration, process.env);
  const psql = process.env.PG_BIN_DIR
    ? join(process.env.PG_BIN_DIR, `psql${process.platform === 'win32' ? '.exe' : ''}`)
    : 'psql';
  function execute(input: string): string {
    const result = spawnSync(psql, ['-X', '-q', '-t', '-A', '-v', 'ON_ERROR_STOP=1'], {
      env,
      input,
      encoding: 'utf8',
      windowsHide: true,
      maxBuffer: 8_000_000,
    });
    if (result.error || result.status !== 0) throw new Error('LOCAL_SETUP_SQL_FAILED');
    return result.stdout.trim();
  }
  const tables = execute(
    "SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname NOT IN ('pg_catalog','information_schema') AND n.nspname NOT LIKE 'pg_toast%' AND c.relkind IN ('r','p','v','m','S');",
  );
  if (tables !== '0') throw new Error('LOCAL_SETUP_EMPTY_DATABASE_REQUIRED');
  const roleBefore = execute(
    "SELECT rolsuper OR rolbypassrls OR rolcreatedb OR rolcreaterole OR NOT rolcanlogin FROM pg_roles WHERE rolname='app_user';",
  );
  if (roleBefore && roleBefore !== 'f') throw new Error('LOCAL_SETUP_EXISTING_ROLE_UNSAFE');
  const backup = await createVerifiedBackup({ root, env: process.env, target });
  const progressDirectory = join(root, 'scratch/local-setup');
  mkdirSync(progressDirectory, { recursive: true });
  const progressFile = join(progressDirectory, `${target.fingerprint}.json`);
  const completed: string[] = [];
  const saveProgress = () =>
    writeFileSync(progressFile, JSON.stringify({ backup, completed }, null, 2));
  saveProgress();
  console.log(`Verified backup and migration progress recorded at ${progressFile}`);
  const journal = JSON.parse(
    readFileSync(join(root, 'packages/db/drizzle/meta/_journal.json'), 'utf8'),
  ) as {
    entries: Array<{ tag: string; when: number }>;
  };
  const manual = JSON.parse(
    readFileSync(join(root, 'scripts/lib/manual-migration-order.json'), 'utf8').replace(
      /^\uFEFF/,
      '',
    ),
  ) as {
    early: string[];
    late: string[];
  };
  const files = journal.entries.map((entry) => `${entry.tag}.sql`);
  const order = [
    ...files.slice(0, 4),
    ...manual.early,
    ...files.slice(4, 9),
    ...manual.late,
    ...files.slice(9),
  ];
  for (const file of order) {
    try {
      execute(
        readFileSync(join(root, 'packages/db/drizzle', file), 'utf8').replaceAll(
          '--> statement-breakpoint',
          '',
        ),
      );
      completed.push(file);
      saveProgress();
    } catch {
      throw new Error(`LOCAL_SETUP_MIGRATION_FAILED_${file}`);
    }
  }
  execute(
    'CREATE SCHEMA IF NOT EXISTS drizzle; CREATE TABLE drizzle.__drizzle_migrations (id SERIAL PRIMARY KEY, hash text NOT NULL, created_at bigint);',
  );
  for (const entry of journal.entries) {
    const hash = createHash('sha256')
      .update(readFileSync(join(root, 'packages/db/drizzle', `${entry.tag}.sql`)))
      .digest('hex');
    execute(
      `INSERT INTO drizzle.__drizzle_migrations (hash, created_at) VALUES ('${hash}', ${entry.when});`,
    );
  }
  const password = decodeURIComponent(runtime.password).replaceAll("'", "''");
  if (!roleBefore) execute(`ALTER ROLE app_user LOGIN PASSWORD '${password}';`);
  if (
    execute(
      "SELECT count(*) FROM pg_roles WHERE rolname='app_user' AND NOT rolsuper AND NOT rolbypassrls AND NOT rolcreaterole;",
    ) !== '1'
  ) {
    throw new Error('LOCAL_SETUP_RUNTIME_ROLE_UNSAFE');
  }
  const runtimeTarget = resolveDatabaseTarget({ DATABASE_URL: runtime.toString() });
  const probe = spawnSync(
    psql,
    ['-X', '-q', '-t', '-A', '-v', 'ON_ERROR_STOP=1', '-c', 'SELECT current_user;'],
    {
      env: databaseProcessEnvironment(runtimeTarget.migration, process.env),
      encoding: 'utf8',
      windowsHide: true,
    },
  );
  if (probe.status !== 0 || probe.stdout.trim() !== 'app_user')
    throw new Error('LOCAL_SETUP_RUNTIME_LOGIN_FAILED');
  console.log('Local schema initialized. Backup verified. Start the app with APP_DATABASE_URL.');
}

main().catch((error: unknown) => {
  console.error(
    error instanceof Error && error.message.startsWith('LOCAL_SETUP_')
      ? error.message
      : 'LOCAL_SETUP_FAILED',
  );
  process.exitCode = 1;
});
