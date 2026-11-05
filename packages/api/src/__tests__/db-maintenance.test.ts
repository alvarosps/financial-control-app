import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  type CommandRunner,
  createVerifiedBackup,
  maintainDatabase,
} from '../../../../scripts/lib/database-maintenance.ts';
import { resolveDatabaseTarget } from '../../../../scripts/lib/database-target.ts';

const folders: string[] = [];
afterEach(async () => {
  await Promise.all(
    folders.splice(0).map((folder) => rm(folder, { recursive: true, force: true })),
  );
});

async function fixture(failure?: 'dump' | 'empty' | 'list' | 'identity' | 'migrate' | 'journal') {
  const root = await mkdtemp(join(tmpdir(), 'fc-maintenance-'));
  folders.push(root);
  const dir = join(root, 'packages/db/drizzle/meta');
  await mkdir(dir, { recursive: true });
  const entries = Array.from({ length: 9 }, (_, idx) => ({
    idx,
    tag: `000${idx}_fixture`,
    when: idx + 1,
  }));
  await writeFile(join(dir, '_journal.json'), JSON.stringify({ entries }));
  for (const entry of entries)
    await writeFile(join(dir, '..', `${entry.tag}.sql`), `SELECT ${entry.idx};`);
  await writeFile(join(dir, '../MIGRATION-ORDER.md'), 'Reviewed manual replay order');
  const env = {
    DATABASE_URL: 'postgresql://postgres:secret%40pass@localhost:5433/financial_control_v2_test',
    PGHOSTADDR: 'unsafe',
    PGSERVICE: 'unsafe',
  };
  const target = resolveDatabaseTarget(env);
  const commands: Parameters<CommandRunner>[0][] = [];
  const run: CommandRunner = async (command) => {
    commands.push(command);
    const file = basename(command.file).replace('.exe', '');
    if (file === 'psql') {
      if (command.args.join(' ').includes('SELECT coalesce(json_agg')) {
        return JSON.stringify(
          failure === 'journal'
            ? []
            : entries.map((entry) => ({
                hash: createHash('sha256').update(`SELECT ${entry.idx};`).digest('hex'),
                created_at: String(entry.when),
              })),
        );
      }
      return JSON.stringify({
        database: failure === 'identity' ? 'other' : target.migration.database,
        user: 'postgres',
        journal: true,
      });
    }
    if (file === 'pg_dump') {
      if (command.args.includes('--schema-only'))
        return '-- schema\nCREATE TABLE fixture(id integer);\n';
      if (failure === 'dump') throw new Error('secret@pass postgres://credentials');
      const index = command.args.indexOf('--file');
      await writeFile(command.args[index + 1], failure === 'empty' ? '' : 'PGDMP fixture');
    }
    if (file === 'pg_restore' && failure === 'list') throw new Error('secret@pass');
    if (command.args.some((arg) => arg.endsWith('bin.cjs')) && failure === 'migrate')
      throw new Error('secret@pass');
    return 'ok';
  };
  return { root, env, target, run, commands };
}

describe('safe database maintenance', () => {
  it('dry-run needs no commands or writes and never exposes credentials', async () => {
    const f = await fixture();
    const result = await maintainDatabase({ ...f, mode: 'migrate' });
    expect(JSON.stringify(result)).toContain(f.target.fingerprint);
    expect(JSON.stringify(result)).not.toContain('secret');
    expect(f.commands).toHaveLength(0);
  });

  it('writes a checksum receipt only after a nonempty, listable backup of the resolved target', async () => {
    const f = await fixture();
    const receipt = await createVerifiedBackup(f);
    expect(receipt.target).toBe(f.target.fingerprint);
    expect(receipt.sha256).toBe(
      createHash('sha256')
        .update(await readFile(receipt.file))
        .digest('hex'),
    );
    expect(JSON.parse(await readFile(`${receipt.file}.json`, 'utf8'))).toEqual(receipt);
    expect(f.commands.map((c) => basename(c.file).replace('.exe', ''))).toEqual([
      'psql',
      'pg_dump',
      'pg_restore',
    ]);
    for (const command of f.commands) {
      expect(command.args.join(' ')).not.toContain('secret');
      expect(command.env.PGDATABASE).toBe('financial_control_v2_test');
      expect(command.env.PGPASSWORD).toBe('secret@pass');
      expect(command.env.PGHOSTADDR).toBeUndefined();
      expect(command.env.PGSERVICE).toBeUndefined();
    }
  });

  it.each([
    'dump',
    'empty',
    'list',
    'identity',
  ] as const)('aborts a %s failure without leaking child output', async (failure) => {
    const f = await fixture(failure);
    await expect(createVerifiedBackup(f)).rejects.toThrow(/^DATABASE_/);
    try {
      await createVerifiedBackup(f);
    } catch (error) {
      expect(String(error)).not.toContain('secret');
    }
    expect(f.commands.some((c) => c.args.includes('migrate'))).toBe(false);
  });

  it('requires both explicit target confirmation and a reviewed baseline before migration', async () => {
    const f = await fixture();
    await expect(maintainDatabase({ ...f, mode: 'migrate', apply: true })).rejects.toThrow(
      'DATABASE_TARGET_CONFIRMATION_REQUIRED',
    );
    await expect(
      maintainDatabase({ ...f, mode: 'migrate', apply: true, confirmTarget: f.target.fingerprint }),
    ).rejects.toThrow('DATABASE_BASELINE_REQUIRED');
    expect(f.commands).toHaveLength(0);
  });

  it('refuses an incomplete historical journal instead of inventing a baseline', async () => {
    const f = await fixture('journal');
    await expect(maintainDatabase({ ...f, mode: 'inspect' })).rejects.toThrow(
      'DATABASE_HISTORY_REVIEW_REQUIRED',
    );
    expect(f.commands.some((c) => c.args.includes('migrate'))).toBe(false);
  });

  it('compares reviewed schema/history, backs up, then uses the same target for migration', async () => {
    const f = await fixture();
    const inspection = (await maintainDatabase({ ...f, mode: 'inspect' })) as Record<
      string,
      unknown
    >;
    const baseline = join(f.root, 'baseline.json');
    await writeFile(
      baseline,
      JSON.stringify({ ...inspection, reviewed: true, reviewedBy: 'operator' }),
    );
    const result = await maintainDatabase({
      ...f,
      mode: 'migrate',
      apply: true,
      confirmTarget: f.target.fingerprint,
      baseline,
    });
    expect(result).toMatchObject({ status: 'applied', target: f.target.fingerprint });
    const last = f.commands.at(-1);
    expect(last?.args).toContain('migrate');
    expect(last?.env.DATABASE_URL).toBe(f.target.migration.url);
    const listIndex = f.commands.findIndex((c) => c.args.includes('--list'));
    expect(listIndex).toBeGreaterThan(0);
    expect(listIndex).toBeLessThan(f.commands.length - 1);
  });

  it('rejects schema drift before any migration or backup', async () => {
    const f = await fixture();
    const inspection = (await maintainDatabase({ ...f, mode: 'inspect' })) as Record<
      string,
      unknown
    >;
    const baseline = join(f.root, 'baseline.json');
    await writeFile(
      baseline,
      JSON.stringify({
        ...inspection,
        schemaSha256: 'stale',
        reviewed: true,
        reviewedBy: 'operator',
      }),
    );
    await expect(
      maintainDatabase({
        ...f,
        mode: 'migrate',
        apply: true,
        confirmTarget: f.target.fingerprint,
        baseline,
      }),
    ).rejects.toThrow('DATABASE_BASELINE_MISMATCH');
    expect(f.commands.some((c) => c.args.includes('--file') || c.args.includes('migrate'))).toBe(
      false,
    );
  });

  it.each([
    'timestamp',
    'removal',
    'reorder',
    'manual-entry',
  ] as const)('rejects pending journal %s drift before any migration or backup', async (change) => {
    const f = await fixture();
    const directory = join(f.root, 'packages/db/drizzle');
    const journalPath = join(directory, 'meta/_journal.json');
    const journal = JSON.parse(await readFile(journalPath, 'utf8')) as {
      entries: { idx: number; tag: string; when: number }[];
    };
    journal.entries.push(
      { idx: 9, tag: '0009_pending', when: 10 },
      { idx: 10, tag: '0010_pending', when: 11 },
    );
    await writeFile(join(directory, '0009_pending.sql'), 'SELECT 9;');
    await writeFile(join(directory, '0010_pending.sql'), 'SELECT 10;');
    await writeFile(join(directory, 'manual_hardening.sql'), 'SELECT 11;');
    await writeFile(journalPath, JSON.stringify(journal));
    const inspection = (await maintainDatabase({ ...f, mode: 'inspect' })) as Record<
      string,
      unknown
    >;
    const baseline = join(f.root, 'baseline.json');
    await writeFile(
      baseline,
      JSON.stringify({ ...inspection, reviewed: true, reviewedBy: 'operator' }),
    );
    if (change === 'timestamp') journal.entries[10].when = 12;
    if (change === 'removal') journal.entries.pop();
    if (change === 'reorder')
      [journal.entries[9], journal.entries[10]] = [journal.entries[10], journal.entries[9]];
    if (change === 'manual-entry')
      journal.entries.push({ idx: 11, tag: 'manual_hardening', when: 12 });
    await writeFile(journalPath, JSON.stringify(journal));
    await expect(
      maintainDatabase({
        ...f,
        mode: 'migrate',
        apply: true,
        confirmTarget: f.target.fingerprint,
        baseline,
      }),
    ).rejects.toThrow(/^DATABASE_(BASELINE_MISMATCH|HISTORY_REVIEW_REQUIRED)$/);
    expect(f.commands.some((c) => c.args.includes('--file') || c.args.includes('migrate'))).toBe(
      false,
    );
  });

  it.each([
    { name: 'duplicate tag', idx: 9, tag: '0008_fixture', when: 10 },
    { name: 'duplicate index', idx: 8, tag: '0009_pending', when: 10 },
    { name: 'skipped index', idx: 10, tag: '0009_pending', when: 10 },
    { name: 'equal timestamp', idx: 9, tag: '0009_pending', when: 9 },
    { name: 'older timestamp', idx: 9, tag: '0009_pending', when: 8 },
    { name: 'fractional timestamp', idx: 9, tag: '0009_pending', when: 10.5 },
    { name: 'unsafe tag', idx: 9, tag: '../outside', when: 10 },
  ])('rejects a pending $name during inspection', async ({ name: _name, ...pending }) => {
    const f = await fixture();
    const journalPath = join(f.root, 'packages/db/drizzle/meta/_journal.json');
    const journal = JSON.parse(await readFile(journalPath, 'utf8')) as {
      entries: { idx: number; tag: string; when: number }[];
    };
    journal.entries.push(pending);
    await writeFile(journalPath, JSON.stringify(journal));
    await expect(maintainDatabase({ ...f, mode: 'inspect' })).rejects.toThrow(
      'DATABASE_HISTORY_REVIEW_REQUIRED',
    );
    expect(f.commands.some((c) => c.args.includes('--file') || c.args.includes('migrate'))).toBe(
      false,
    );
  });

  it('retains the verified backup and masks a migration child failure', async () => {
    const f = await fixture('migrate');
    const inspection = (await maintainDatabase({ ...f, mode: 'inspect' })) as Record<
      string,
      unknown
    >;
    const baseline = join(f.root, 'baseline.json');
    await writeFile(
      baseline,
      JSON.stringify({ ...inspection, reviewed: true, reviewedBy: 'operator' }),
    );
    await expect(
      maintainDatabase({
        ...f,
        mode: 'migrate',
        apply: true,
        confirmTarget: f.target.fingerprint,
        baseline,
      }),
    ).rejects.toThrow('DATABASE_MIGRATION_FAILED: backup retained');
    const dump = f.commands.find((c) => c.args.includes('--file'));
    expect(dump).toBeDefined();
    if (!dump) throw new Error('Expected backup');
    expect(await readFile(dump.args[dump.args.indexOf('--file') + 1], 'utf8')).toBe(
      'PGDMP fixture',
    );
  });
});
