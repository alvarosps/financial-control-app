import type { DbExecutor } from '@fc/db';
import { sql } from 'drizzle-orm';
import { assertIntegrationRole, claimIntegrationJob } from './integration-job.service.ts';
import type { PluggyClient } from './pluggy-client.ts';
import { PluggySyncService } from './pluggy-sync.service.ts';
import { integrationResponse, integrationSecretMatches } from './pluggy-webhook.service.ts';

export async function handleIntegrationCron(
  request: Request,
  secret: string,
  deps: { app: DbExecutor; scheduler: DbExecutor; client: PluggyClient; now?: () => number },
) {
  const token = request.headers.get('authorization')?.replace(/^Bearer /, '') ?? null;
  if (
    !request.headers.get('authorization')?.startsWith('Bearer ') ||
    !integrationSecretMatches(token, secret)
  )
    return integrationResponse({ error: 'UNAUTHORIZED' }, 401);
  if (request.method !== 'GET') return integrationResponse({ error: 'METHOD_NOT_ALLOWED' }, 405);
  const now = deps.now ?? Date.now;
  const deadline = now() + 40_000;
  try {
    await assertIntegrationRole(deps.app, 'app_user');
    await assertIntegrationRole(deps.scheduler, 'integration_scheduler');
    const allowed = await deps.scheduler.execute(
      sql`SELECT take_integration_ingress('scheduler') AS allowed`,
    );
    if (!allowed[0]?.allowed) return integrationResponse({ error: 'RATE_LIMITED' }, 429);
    await deps.scheduler.execute(sql`SELECT enqueue_integration_recovery()`);
    let processed = 0;
    while (processed < 20 && now() < deadline) {
      const lease = await claimIntegrationJob(deps.scheduler);
      if (!lease) return integrationResponse({ processed, stopped: 'idle' });
      await new PluggySyncService(deps.app, deps.client).step(lease);
      processed++;
    }
    return integrationResponse({ processed, stopped: now() >= deadline ? 'deadline' : 'batch' });
  } catch {
    return integrationResponse({ error: 'INTEGRATION_UNAVAILABLE' }, 503);
  }
}
