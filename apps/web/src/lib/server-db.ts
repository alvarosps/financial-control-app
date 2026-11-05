import 'server-only';

import { createServerDb, type Database } from '@fc/api';

let dbSingleton: Database | null = null;

export function getServerDb(): Database {
  if (!process.env.APP_DATABASE_URL) {
    throw new Error('APP_DATABASE_URL environment variable is required (app_user role)');
  }
  dbSingleton ??= createServerDb(process.env.APP_DATABASE_URL);
  return dbSingleton;
}
