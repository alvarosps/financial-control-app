import { createIntegrationDatabases, handleIntegrationCron, PluggyClient } from '@fc/api';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

export async function GET(request: Request) {
  const {
    APP_DATABASE_URL,
    INTEGRATION_SCHEDULER_DATABASE_URL,
    PLUGGY_CLIENT_ID,
    PLUGGY_CLIENT_SECRET,
    CRON_SECRET,
  } = process.env;
  if (
    process.env.PLUGGY_ENABLED !== 'true' ||
    !APP_DATABASE_URL ||
    !INTEGRATION_SCHEDULER_DATABASE_URL ||
    !PLUGGY_CLIENT_ID ||
    !PLUGGY_CLIENT_SECRET ||
    !CRON_SECRET
  )
    return Response.json({ error: 'INTEGRATION_DISABLED' }, { status: 503 });
  try {
    const databases = createIntegrationDatabases(
      APP_DATABASE_URL,
      INTEGRATION_SCHEDULER_DATABASE_URL,
    );
    const client = new PluggyClient({
      clientId: PLUGGY_CLIENT_ID,
      clientSecret: PLUGGY_CLIENT_SECRET,
      deadlineAt: Date.now() + 40_000,
    });
    return await handleIntegrationCron(request, CRON_SECRET, { ...databases, client });
  } catch {
    return Response.json({ error: 'INTEGRATION_UNAVAILABLE' }, { status: 503 });
  }
}
