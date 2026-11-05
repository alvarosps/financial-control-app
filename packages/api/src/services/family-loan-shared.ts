import type { DbExecutor } from '@fc/db';
import { accounts, familyLoanConfigs } from '@fc/db';
import { TRPCError } from '@trpc/server';
import { and, eq } from 'drizzle-orm';

export type FamilyLoanConfigRow = typeof familyLoanConfigs.$inferSelect;

/**
 * Loader tenant-scoped compartilhado pelos serviços de family-loan
 * (flow/ledger/payment). Tenant-scope no ÚNICO SELECT: configs fazem join com
 * accounts, então um configId estrangeiro não retorna linha nem transientemente.
 * Linha ausente OU de outro usuário → mesmo NOT_FOUND (não vaza existência).
 */
export async function loadFamilyLoanConfig(
  db: DbExecutor,
  userId: string,
  configId: string,
): Promise<FamilyLoanConfigRow> {
  const [row] = await db
    .select({ config: familyLoanConfigs })
    .from(familyLoanConfigs)
    .innerJoin(accounts, eq(accounts.id, familyLoanConfigs.accountId))
    .where(and(eq(familyLoanConfigs.id, configId), eq(accounts.userId, userId)));

  if (!row) {
    throw new TRPCError({ code: 'NOT_FOUND', message: 'Family loan config not found' });
  }

  return row.config;
}
