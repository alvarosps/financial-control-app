import 'server-only';
import { createHash } from 'node:crypto';
import { createDb, type Database } from '@fc/db';
import { createServerDb } from './server-bootstrap.ts';

declare global {
  var __fc_scheduler: { fingerprint: string; db: Database } | undefined;
}
export function createIntegrationDatabases(appUrl: string, schedulerUrl: string) {
  let app: URL;
  let scheduler: URL;
  try {
    app = new URL(appUrl);
    scheduler = new URL(schedulerUrl);
  } catch {
    throw new Error('INTEGRATION_DATABASE_CONFIGURATION_INVALID');
  }
  if (
    decodeURIComponent(app.username).split('.')[0] !== 'app_user' ||
    decodeURIComponent(scheduler.username).split('.')[0] !== 'integration_scheduler' ||
    app.hostname !== scheduler.hostname ||
    app.port !== scheduler.port ||
    app.pathname !== scheduler.pathname ||
    scheduler.searchParams.has('options') ||
    app.searchParams.has('options')
  ) {
    throw new Error('INTEGRATION_DATABASE_CONFIGURATION_INVALID');
  }
  const fingerprint = createHash('sha256').update(schedulerUrl).digest('hex');
  if (globalThis.__fc_scheduler && globalThis.__fc_scheduler.fingerprint !== fingerprint)
    throw new Error('INTEGRATION_DATABASE_RESTART_REQUIRED');
  const cached = globalThis.__fc_scheduler ?? { fingerprint, db: createDb(schedulerUrl) };
  globalThis.__fc_scheduler = cached;
  return { app: createServerDb(appUrl), scheduler: cached.db };
}
