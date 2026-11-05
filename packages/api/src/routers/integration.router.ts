import type { DbExecutor } from '@fc/db';
import { TRPCError } from '@trpc/server';
import { z } from 'zod';
import {
  BankReconciliationService,
  bankLinkSchema,
  bankUnlinkSchema,
} from '../services/bank-reconciliation.service.ts';
import { IntegrationStatusService } from '../services/pluggy/integration-status.service.ts';
import { PluggyClient } from '../services/pluggy/pluggy-client.ts';
import {
  PluggyConnectionService,
  parsePersonalItemGrants,
} from '../services/pluggy/pluggy-connection.service.ts';
import { protectedProcedure, router } from '../trpc.ts';

function configuration() {
  try {
    const grants = parsePersonalItemGrants(process.env.PLUGGY_PERSONAL_ITEMS);
    return {
      grants,
      enabled:
        process.env.PLUGGY_ENABLED === 'true' &&
        !!process.env.PLUGGY_CLIENT_ID &&
        !!process.env.PLUGGY_CLIENT_SECRET,
    };
  } catch {
    return { grants: [], enabled: false };
  }
}
function requireEnabled() {
  if (!configuration().enabled)
    throw new TRPCError({
      code: 'PRECONDITION_FAILED',
      message: 'Personal integration is not configured',
    });
}
function connectionService(db: DbExecutor) {
  return new PluggyConnectionService(
    db,
    new PluggyClient({
      clientId: process.env.PLUGGY_CLIENT_ID ?? '',
      clientSecret: process.env.PLUGGY_CLIENT_SECRET ?? '',
    }),
    configuration().grants,
  );
}
const connectionInput = z.object({ connectionId: z.guid() }).strict();
const accountInput = z.object({ externalAccountId: z.guid() }).strict();
const listInput = accountInput.extend({ cursor: z.guid().optional() });
export const integrationRouter = router({
  list: protectedProcedure.query(async ({ ctx }) => ({
    enabled: configuration().enabled,
    configuredItems: configuration()
      .grants.filter((g) => g.userId === ctx.userId)
      .map((g) => g.itemId),
    connections: await new IntegrationStatusService(ctx.db).list(ctx.userId),
  })),
  attach: protectedProcedure
    .input(z.object({ itemId: z.guid() }).strict())
    .mutation(({ ctx, input }) => {
      requireEnabled();
      return connectionService(ctx.db).attach(ctx.userId, input.itemId);
    }),
  sync: protectedProcedure.input(connectionInput).mutation(({ ctx, input }) => {
    requireEnabled();
    return connectionService(ctx.db).requestSync(ctx.userId, input.connectionId);
  }),
  resume: protectedProcedure.input(connectionInput).mutation(({ ctx, input }) => {
    requireEnabled();
    return connectionService(ctx.db).setPaused(ctx.userId, input.connectionId, false);
  }),
  pause: protectedProcedure
    .input(connectionInput)
    .mutation(({ ctx, input }) =>
      connectionService(ctx.db).setPaused(ctx.userId, input.connectionId, true),
    ),
  mapAccount: protectedProcedure
    .input(accountInput.extend({ accountId: z.guid() }))
    .mutation(({ ctx, input }) =>
      connectionService(ctx.db).mapAccount(ctx.userId, input.externalAccountId, input.accountId),
    ),
  bankMovements: protectedProcedure
    .input(listInput)
    .query(({ ctx, input }) => new BankReconciliationService(ctx.db).list(ctx.userId, input)),
  bankDetail: protectedProcedure
    .input(z.object({ movementId: z.guid() }).strict())
    .query(({ ctx, input }) =>
      new BankReconciliationService(ctx.db).detail(ctx.userId, input.movementId),
    ),
  linkBank: protectedProcedure
    .input(bankLinkSchema)
    .mutation(({ ctx, input }) => new BankReconciliationService(ctx.db).link(ctx.userId, input)),
  unlinkBank: protectedProcedure
    .input(bankUnlinkSchema)
    .mutation(({ ctx, input }) => new BankReconciliationService(ctx.db).unlink(ctx.userId, input)),
  balance: protectedProcedure
    .input(accountInput)
    .query(({ ctx, input }) =>
      new BankReconciliationService(ctx.db).balance(ctx.userId, input.externalAccountId),
    ),
  cardExceptions: protectedProcedure
    .input(listInput)
    .query(({ ctx, input }) =>
      new IntegrationStatusService(ctx.db).cardExceptions(ctx.userId, input),
    ),
});
