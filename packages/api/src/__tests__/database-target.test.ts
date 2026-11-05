import { describe, expect, it } from 'vitest';
import {
  configureTestDatabaseEnvironment,
  resolveDatabaseTarget,
} from '../../../../scripts/lib/database-target.ts';

const LOCAL = 'postgresql://postgres:p%40ss%3Aword@localhost:5433/financial_control_v2_test';

describe('database maintenance target', () => {
  it('uses the same explicit target for backup and migration without exposing its password', () => {
    const target = resolveDatabaseTarget({ DATABASE_URL: LOCAL });
    expect(target.migration.database).toBe('financial_control_v2_test');
    expect(target.migration.port).toBe('5433');
    expect(target.backup.url).toBe(target.migration.url);
    expect(target.backup.pgEnv.PGPASSWORD).toBe('p@ss:word');
    expect(target.label).toBe('localhost:5433/financial_control_v2_test (postgres)');
    expect(target.fingerprint).toMatch(/^[a-f0-9]{64}$/);
    expect(target.label).not.toContain('p@ss');
    expect(
      resolveDatabaseTarget({ DATABASE_URL: LOCAL.replace('p%40ss%3Aword', 'changed') })
        .fingerprint,
    ).toBe(target.fingerprint);
  });

  it.each([
    {},
    { DATABASE_URL: 'not-a-database-url-SECRET' },
    { DATABASE_URL: 'https://postgres:SECRET@example.com/database' },
    { DATABASE_URL: 'postgresql://postgres:SECRET@localhost/' },
    { DATABASE_URL: 'postgresql://postgres:SECRET@localhost/db?host=evil.example' },
    { DATABASE_URL: 'postgresql://postgres:SECRET@localhost/db?options=-c%20role=other' },
    { DATABASE_URL: 'postgresql://postgres:SECRET@localhost/db#fragment' },
  ])('rejects missing or ambiguous URLs without echoing credentials: case %#', (env) => {
    let error: unknown;
    try {
      resolveDatabaseTarget(env);
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(Error);
    expect(String(error)).not.toContain('SECRET');
  });

  it.each([
    ['DB_HOST', 'remote.example'],
    ['DB_PORT', '5432'],
    ['DB_NAME', 'postgres'],
    ['DB_USER', 'another'],
    ['DB_PASSWORD', 'SECRET'],
  ])('rejects a conflicting legacy %s rather than backing up another database', (key, value) => {
    expect(() => resolveDatabaseTarget({ DATABASE_URL: LOCAL, [key]: value })).toThrow(
      'DATABASE_TARGET_CONFLICT',
    );
  });

  it('allows matching legacy options but forces remote encryption', () => {
    expect(
      resolveDatabaseTarget({
        DATABASE_URL: LOCAL,
        DB_HOST: 'localhost',
        DB_NAME: 'financial_control_v2_test',
      }).migration.host,
    ).toBe('localhost');
    expect(
      resolveDatabaseTarget({ DATABASE_URL: 'postgres://postgres:secret@db.example.com/db' })
        .migration.pgEnv.PGSSLMODE,
    ).toBe('require');
    expect(() =>
      resolveDatabaseTarget({
        DATABASE_URL: 'postgres://postgres:secret@db.example.com/db?sslmode=disable',
      }),
    ).toThrow('DATABASE_TLS_REQUIRED');
  });

  it('only accepts a direct backup for a pooler with an explicitly matching Supabase project', () => {
    const env = {
      DATABASE_URL:
        'postgres://postgres.projectalpha:p@aws-0-region.pooler.supabase.com:5432/postgres?sslmode=require',
      DATABASE_BACKUP_URL:
        'postgres://postgres:p@db.projectalpha.supabase.co:5432/postgres?sslmode=require',
    };
    expect(() => resolveDatabaseTarget(env)).toThrow('DATABASE_BACKUP_TARGET_UNVERIFIED');
    const target = resolveDatabaseTarget({ ...env, DATABASE_TARGET_PROJECT: 'projectalpha' });
    expect(target.backup.host).toBe('db.projectalpha.supabase.co');
    expect(() =>
      resolveDatabaseTarget({
        ...env,
        DATABASE_TARGET_PROJECT: 'projectalpha',
        DATABASE_BACKUP_URL: env.DATABASE_BACKUP_URL.replace('projectalpha', 'projectbeta'),
      }),
    ).toThrow('DATABASE_BACKUP_TARGET_UNVERIFIED');
  });

  it('does not equate unrelated hosts just because the database is named postgres', () => {
    expect(() =>
      resolveDatabaseTarget({
        DATABASE_URL: 'postgres://postgres:p@first.example/postgres',
        DATABASE_BACKUP_URL: 'postgres://postgres:p@second.example/postgres',
        DATABASE_TARGET_PROJECT: 'projectalpha',
      }),
    ).toThrow('DATABASE_BACKUP_TARGET_UNVERIFIED');
  });
});

describe('test database environment', () => {
  it('routes legacy and rollback tests to the same local test database', () => {
    const env: Record<string, string | undefined> = { TEST_DATABASE_URL: LOCAL };
    configureTestDatabaseEnvironment(env);
    expect(env.DATABASE_URL).toBe(LOCAL);
    expect(env.TEST_DATABASE_URL).toBe(LOCAL);
    expect(env.DATABASE_URL_TEST).toBe(LOCAL);
  });

  it.each([
    {},
    {
      DATABASE_URL: 'postgres://postgres:SECRET@db.example.com/postgres',
      TEST_DATABASE_URL: LOCAL,
    },
    { TEST_DATABASE_URL: 'postgres://postgres:SECRET@db.example.com/production_test' },
    { DATABASE_URL: 'postgres://postgres:SECRET@localhost:5433/financial_control_v2' },
    { TEST_DATABASE_URL: LOCAL, DATABASE_URL_TEST: LOCAL.replace('v2_test', 'another_test') },
  ])('refuses unsafe or conflicting test targets before connecting: case %#', (env) => {
    expect(() => configureTestDatabaseEnvironment(env)).toThrow('UNSAFE_TEST_DATABASE');
  });
});
