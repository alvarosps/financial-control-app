import { createHash } from 'node:crypto';

type Environment = Record<string, string | undefined>;
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);
const SSL_MODES = new Set(['disable', 'allow', 'prefer', 'require', 'verify-ca', 'verify-full']);

export type DatabaseConnection = {
  url: string;
  host: string;
  port: string;
  database: string;
  user: string;
  project: string | null;
  pgEnv: Record<string, string>;
};

export type DatabaseTarget = {
  migration: DatabaseConnection;
  backup: DatabaseConnection;
  fingerprint: string;
  label: string;
};

function parseConnection(value: string | undefined): DatabaseConnection {
  if (!value) throw new Error('DATABASE_URL_REQUIRED');
  let url: URL;
  let user: string;
  let password: string;
  let database: string;
  try {
    url = new URL(value);
    user = decodeURIComponent(url.username);
    password = decodeURIComponent(url.password);
    database = decodeURIComponent(url.pathname.slice(1));
  } catch {
    throw new Error('DATABASE_URL_INVALID');
  }
  if (
    !['postgres:', 'postgresql:'].includes(url.protocol) ||
    !url.hostname ||
    !user ||
    !database ||
    url.hash ||
    /[/\\?#]/.test(database + user) ||
    [...(database + user + password)].some(
      (character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127,
    )
  )
    throw new Error('DATABASE_URL_INVALID');
  for (const key of url.searchParams.keys()) {
    if (!['sslmode', 'connect_timeout'].includes(key) || url.searchParams.getAll(key).length !== 1)
      throw new Error('DATABASE_URL_OPTIONS_UNSUPPORTED');
  }
  const local = LOCAL_HOSTS.has(url.hostname);
  const ssl = url.searchParams.get('sslmode') ?? (local ? 'prefer' : 'require');
  if (!SSL_MODES.has(ssl)) throw new Error('DATABASE_URL_INVALID');
  if (!local && !['require', 'verify-ca', 'verify-full'].includes(ssl))
    throw new Error('DATABASE_TLS_REQUIRED');
  const timeout = url.searchParams.get('connect_timeout') ?? '15';
  if (!/^\d+$/.test(timeout) || Number(timeout) < 1 || Number(timeout) > 300)
    throw new Error('DATABASE_URL_INVALID');
  const port = url.port || '5432';
  const directProject = /^db\.([a-z0-9]+)\.supabase\.co$/.exec(url.hostname)?.[1];
  const poolProject = url.hostname.endsWith('.pooler.supabase.com')
    ? /^[^.]+\.([a-z0-9]+)$/.exec(user)?.[1]
    : undefined;
  url.searchParams.set('sslmode', ssl);
  return {
    url: url.toString(),
    host: url.hostname,
    port,
    database,
    user,
    project: directProject ?? poolProject ?? null,
    pgEnv: {
      PGHOST: url.hostname.replace(/^\[|\]$/g, ''),
      PGPORT: port,
      PGDATABASE: database,
      PGUSER: user,
      PGPASSWORD: password,
      PGSSLMODE: ssl,
      PGCONNECT_TIMEOUT: timeout,
    },
  };
}

export function resolveDatabaseTarget(env: Environment): DatabaseTarget {
  const migration = parseConnection(env.DATABASE_URL);
  const aliases: Record<string, string> = {
    DB_HOST: migration.host,
    DB_PORT: migration.port,
    DB_NAME: migration.database,
    DB_USER: migration.user,
    DB_PASSWORD: migration.pgEnv.PGPASSWORD,
  };
  for (const [key, expected] of Object.entries(aliases)) {
    if (env[key] !== undefined && env[key] !== expected)
      throw new Error('DATABASE_TARGET_CONFLICT');
  }
  const backup = env.DATABASE_BACKUP_URL ? parseConnection(env.DATABASE_BACKUP_URL) : migration;
  const sameEndpoint =
    backup.host === migration.host &&
    backup.port === migration.port &&
    backup.database === migration.database &&
    backup.user === migration.user;
  if (
    !sameEndpoint &&
    !(
      migration.project &&
      migration.project === backup.project &&
      env.DATABASE_TARGET_PROJECT === migration.project &&
      migration.database === backup.database &&
      backup.host === `db.${migration.project}.supabase.co`
    )
  )
    throw new Error('DATABASE_BACKUP_TARGET_UNVERIFIED');
  const identity = migration.project
    ? ['supabase', migration.project, migration.database]
    : [migration.host, migration.port, migration.database];
  return {
    migration,
    backup,
    fingerprint: createHash('sha256').update(JSON.stringify(identity)).digest('hex'),
    label: `${migration.host}:${migration.port}/${migration.database} (${migration.user})`,
  };
}

export function databaseProcessEnvironment(
  connection: DatabaseConnection,
  env: Environment,
): Environment {
  const clean = Object.fromEntries(
    Object.entries(env).filter(
      ([key]) =>
        !key.toUpperCase().startsWith('PG') &&
        !key.startsWith('DB_') &&
        !['DATABASE_URL', 'DATABASE_BACKUP_URL', 'DATABASE_TARGET_PROJECT'].includes(key),
    ),
  );
  return { ...clean, ...connection.pgEnv, DATABASE_URL: connection.url };
}

export function configureTestDatabaseEnvironment(env: Environment): string {
  const keys = ['TEST_DATABASE_URL', 'DATABASE_URL_TEST', 'DATABASE_URL'];
  const selected = env.TEST_DATABASE_URL ?? env.DATABASE_URL_TEST ?? env.DATABASE_URL;
  try {
    if (!selected) throw new Error('missing test target');
    const expected = parseConnection(selected);
    for (const key of keys) {
      const current = parseConnection(env[key] ?? selected);
      if (
        !LOCAL_HOSTS.has(current.host) ||
        !current.database.endsWith('_test') ||
        current.host !== expected.host ||
        current.port !== expected.port ||
        current.database !== expected.database
      )
        throw new Error('unsafe');
    }
    if (env.APP_DATABASE_URL) {
      const app = parseConnection(env.APP_DATABASE_URL);
      if (
        !LOCAL_HOSTS.has(app.host) ||
        app.database !== expected.database ||
        app.port !== expected.port
      )
        throw new Error('unsafe');
    }
  } catch {
    throw new Error('UNSAFE_TEST_DATABASE: tests require one explicit local _test database');
  }
  for (const key of keys) env[key] = selected;
  return selected;
}
