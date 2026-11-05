import type { DbExecutor } from '@fc/db';
import { accounts } from '@fc/db';
import { and, eq } from 'drizzle-orm';
import { BankReconciliationService } from './bank-reconciliation.service.ts';
import { WalletCashService } from './wallet-cash.service.ts';

export class CashReadinessService {
  constructor(private db: DbExecutor) {}
  async get(userId: string, asOf: Date = new Date()) {
    const [cash, wallets] = await Promise.all([
      new WalletCashService(this.db).getWalletCash(userId, asOf),
      this.db
        .select()
        .from(accounts)
        .where(
          and(
            eq(accounts.userId, userId),
            eq(accounts.type, 'checking'),
            eq(accounts.isActive, true),
          ),
        ),
    ]);
    const reasons: string[] = [];
    if (!wallets.length) reasons.push('no_wallet');
    if (wallets.some((w) => w.currency !== 'BRL')) reasons.push('unsupported_currency');
    if (wallets.some((w) => !w.openingBalanceAnchorAt || w.cashAnchorBasis !== 'effective'))
      reasons.push('unreviewed_anchor');
    if (
      wallets.some(
        (w) =>
          w.openingBalanceAnchorAt &&
          (w.openingBalanceAnchorAt > asOf ||
            asOf.getTime() - w.openingBalanceAnchorAt.getTime() > 31 * 86_400_000),
      )
    )
      reasons.push('stale_anchor');
    if (
      cash.wallets.some(
        (w) => w.legacyMovementCount > 0 || w.unresolvedMovementCount > 0 || w.assumedDelta !== 0,
      )
    )
      reasons.push('unresolved_movements');
    const bank = await new BankReconciliationService(this.db).cashEvidence(
      userId,
      wallets.map((wallet) => ({
        id: wallet.id,
        anchorAt: wallet.openingBalanceAnchorAt ?? new Date(0),
      })),
      asOf,
    );
    if (bank.truncated) reasons.push('bank_evidence_overflow');
    if (bank.items.some((item) => item.state !== 'linked'))
      reasons.push('unreconciled_bank_evidence');
    return { ready: reasons.length === 0, reasons, cash };
  }
}
