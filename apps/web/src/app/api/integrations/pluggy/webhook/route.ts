import { createIntegrationDatabases, handlePluggyWebhook } from '@fc/api';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(request: Request) {
  const { APP_DATABASE_URL, INTEGRATION_SCHEDULER_DATABASE_URL, PLUGGY_WEBHOOK_SECRET } =
    process.env;
  if (
    process.env.PLUGGY_ENABLED !== 'true' ||
    !APP_DATABASE_URL ||
    !INTEGRATION_SCHEDULER_DATABASE_URL ||
    !PLUGGY_WEBHOOK_SECRET
  )
    return Response.json({ error: 'INTEGRATION_DISABLED' }, { status: 503 });
  try {
    const { scheduler } = createIntegrationDatabases(
      APP_DATABASE_URL,
      INTEGRATION_SCHEDULER_DATABASE_URL,
    );
    return await handlePluggyWebhook(request, scheduler, PLUGGY_WEBHOOK_SECRET);
  } catch {
    return Response.json({ error: 'INTEGRATION_UNAVAILABLE' }, { status: 503 });
  }
}
