import { accounts, auditLog, type DbExecutor, transactions } from '@fc/db';
import { Money } from '@fc/domain';
import { and, eq, or } from 'drizzle-orm';
import { z } from 'zod';
import {
  type BackupReceipt,
  verifyBackupReceipt,
} from '../../../../scripts/lib/database-maintenance.ts';
import { financialRevision } from '../lib/financial-revision.ts';
import { runWithMaterializationLock } from '../lib/materialization-lock.ts';
import {
  assertNoPayrollAllocation,
  assertNotPayrollLoan,
  assertOpenSettlementPeriods,
  settlementDateKey,
} from '../lib/settlement-guards.ts';
import { AuditService } from './audit.service.ts';
import { WalletCashService } from './wallet-cash.service.ts';

const entrySchema = z
  .object({
    transactionId: z.guid(),
    settlementDate: z.string().datetime({ offset: true }),
    evidence: z.string().trim().min(3).max(500),
    source: z.enum(['manual', 'bank']),
    amount: z.string().regex(/^\d{1,10}\.\d{2}$/),
  })
  .strict();
export const historicalSettlementRequestSchema = z
  .object({
    userId: z.guid(),
    walletId: z.guid(),
    entries: z.array(entrySchema).min(1).max(200),
  })
  .strict();
export const historicalSettlementManifestSchema = z
  .object({
    version: z.literal(1),
    kind: z.literal('historical-settlements'),
    target: z.string().regex(/^[a-f0-9]{64}$/),
    request: historicalSettlementRequestSchema,
    snapshotHash: z.string(),
    cashBefore: z.string(),
    anchorAt: z.string(),
    createdAt: z.string().datetime(),
    hash: z.string(),
  })
  .strict();
export type HistoricalSettlementManifest = z.infer<typeof historicalSettlementManifestSchema>;

export const historicalInverseSchema = z
  .object({
    version: z.literal(1),
    kind: z.literal('historical-settlements-inverse'),
    target: z.string(),
    userId: z.guid(),
    walletId: z.guid(),
    manifestHash: z.string(),
    snapshotHash: z.string(),
    createdAt: z.string().datetime(),
    hash: z.string(),
  })
  .strict();
type Safety = {
  target: string;
  confirmTarget: string;
  expectedHash: string;
  producersPaused: boolean;
  backup: BackupReceipt;
};
const beforeSchema = z.object({
  wallet: z.object({ cashAnchorBasis: z.enum(['recorded', 'effective']) }),
  transactions: z.array(
    z.object({
      id: z.guid(),
      isPaid: z.boolean(),
      paidAt: z.coerce.date().nullable(),
      settlementDate: z.coerce.date().nullable(),
      settlementSource: z.enum(['manual', 'bank', 'payroll', 'legacy', 'date_assumed']),
      paidFromAccountId: z.guid().nullable(),
      cashAmount: z.string().nullable(),
      updatedAt: z.coerce.date(),
    }),
  ),
});
async function validateSafety(
  raw: { hash: string; target: string; createdAt: string },
  safety: Safety,
) {
  const { hash, ...content } = raw;
  if (
    hash !== financialRevision(content) ||
    hash !== safety.expectedHash ||
    raw.target !== safety.target ||
    safety.confirmTarget !== safety.target ||
    !safety.producersPaused
  )
    throw new Error('HISTORICAL_REVIEW_REQUIRED');
  await verifyBackupReceipt(safety.backup, { fingerprint: raw.target });
  if (new Date(safety.backup.createdAt) < new Date(raw.createdAt))
    throw new Error('HISTORICAL_FRESH_BACKUP_REQUIRED');
}

/** Tooling-only repair. Historical confirmation never goes through a generic payment button. */
export class HistoricalSettlementService {
  constructor(private db: DbExecutor) {}
  private async snapshot(raw: z.input<typeof historicalSettlementRequestSchema>) {
    const request = historicalSettlementRequestSchema.parse(raw);
    if (new Set(request.entries.map((e) => e.transactionId)).size !== request.entries.length)
      throw new Error('HISTORICAL_DUPLICATE_ENTRY');
    const [wallet] = await this.db
      .select()
      .from(accounts)
      .where(and(eq(accounts.userId, request.userId), eq(accounts.id, request.walletId)));
    if (
      !wallet?.isActive ||
      wallet.type !== 'checking' ||
      wallet.currency !== 'BRL' ||
      !wallet.openingBalanceAnchorAt
    )
      throw new Error('HISTORICAL_WALLET_REQUIRED');
    const rows = await this.db
      .select()
      .from(transactions)
      .where(
        and(
          eq(transactions.userId, request.userId),
          or(
            eq(transactions.sourceAccountId, wallet.id),
            eq(transactions.destinationAccountId, wallet.id),
            eq(transactions.paidFromAccountId, wallet.id),
          ),
        ),
      )
      .orderBy(transactions.id);
    const anchor = wallet.openingBalanceAnchorAt;
    for (const entry of request.entries) {
      const row = rows.find((r) => r.id === entry.transactionId);
      const effective = new Date(entry.settlementDate);
      if (
        !row ||
        row.isPaid ||
        row.isReversed ||
        row.reversesTransactionId ||
        ![
          'recurring_bill',
          'loan_payment',
          'loan_insurance',
          'income_clt',
          'income_pj',
          'income_rental',
        ].includes(row.domainType ?? '') ||
        (row.domainType?.startsWith('income_')
          ? row.destinationAccountId !== wallet.id
          : row.sourceAccountId !== wallet.id) ||
        row.currency !== 'BRL' ||
        row.amount !== entry.amount ||
        effective >= anchor ||
        effective > new Date()
      )
        throw new Error('HISTORICAL_ENTRY_NOT_ELIGIBLE');
      await assertNoPayrollAllocation(this.db, request.userId, row.id);
      await assertNotPayrollLoan(this.db, row.destinationAccountId, row.domainType);
      await assertOpenSettlementPeriods(this.db, request.userId, [
        row.date.toISOString().slice(0, 10),
        settlementDateKey(effective),
        settlementDateKey(anchor),
      ]);
    }
    // A recorded-time anchor cannot be converted while crossing movements lack effective evidence.
    for (const row of rows) {
      if (
        !row.isPaid ||
        row.isReversed ||
        row.reversesTransactionId ||
        row.settlementSource === 'date_assumed'
      )
        continue;
      if (row.domainType?.startsWith('family_loan_') && row.domainType !== 'family_loan_payment')
        continue;
      const crosses =
        (row.paidAt && row.paidAt > anchor) || (row.settlementDate && row.settlementDate > anchor);
      if (
        crosses &&
        (!row.settlementDate ||
          row.settlementSource === 'legacy' ||
          (row.currency !== 'BRL' && row.cashAmount === null))
      )
        throw new Error('HISTORICAL_CROSSING_MOVEMENT_UNREVIEWED');
    }
    const cash = (await new WalletCashService(this.db).getWalletCash(request.userId)).wallets.find(
      (w) => w.id === wallet.id,
    );
    if (!cash) throw new Error('HISTORICAL_CASH_REQUIRED');
    return {
      request,
      wallet,
      rows,
      cash: Money.fromNumber(cash.cash, 'BRL').toDbString(),
      hash: financialRevision({ wallet, rows }),
    };
  }
  async preview(
    request: z.input<typeof historicalSettlementRequestSchema>,
    target: string,
  ): Promise<HistoricalSettlementManifest> {
    const snapshot = await this.snapshot(request);
    const manifest = {
      version: 1 as const,
      kind: 'historical-settlements' as const,
      target,
      request: snapshot.request,
      snapshotHash: snapshot.hash,
      cashBefore: snapshot.cash,
      anchorAt: snapshot.wallet.openingBalanceAnchorAt?.toISOString() ?? '',
      createdAt: new Date().toISOString(),
    };
    return historicalSettlementManifestSchema.parse({
      ...manifest,
      hash: financialRevision(manifest),
    });
  }
  async apply(
    raw: unknown,
    safety: {
      target: string;
      confirmTarget: string;
      expectedHash: string;
      producersPaused: boolean;
      backup: BackupReceipt;
    },
  ) {
    const manifest = historicalSettlementManifestSchema.parse(raw);
    await validateSafety(manifest, safety);
    const hash = manifest.hash;
    return runWithMaterializationLock(this.db, manifest.request.userId, async ({ db }) => {
      const applied = await db
        .select()
        .from(auditLog)
        .where(
          and(
            eq(auditLog.userId, manifest.request.userId),
            eq(auditLog.action, 'historical_settlement'),
            eq(auditLog.entityId, manifest.request.walletId),
          ),
        );
      if (
        applied.some(
          (a) =>
            a.newData &&
            typeof a.newData === 'object' &&
            'manifestHash' in a.newData &&
            a.newData.manifestHash === hash,
        )
      ) {
        const prior = applied.find(
          (a) =>
            a.newData &&
            typeof a.newData === 'object' &&
            'manifestHash' in a.newData &&
            a.newData.manifestHash === hash,
        );
        const previous = z.object({ afterHash: z.string() }).parse(prior?.newData);
        if (
          previous.afterHash !==
          (await new HistoricalSettlementService(db).stateHash(
            manifest.request.userId,
            manifest.request.walletId,
          ))
        )
          throw new Error('HISTORICAL_REPLAY_STATE_CHANGED');
        return { replayed: true, manifestHash: hash };
      }
      const before = await new HistoricalSettlementService(db).snapshot(manifest.request);
      if (before.hash !== manifest.snapshotHash || before.cash !== manifest.cashBefore)
        throw new Error('HISTORICAL_SNAPSHOT_CHANGED');
      const recordedAt = new Date();
      for (const entry of manifest.request.entries) {
        await db
          .update(transactions)
          .set({
            isPaid: true,
            paidAt: recordedAt,
            settlementDate: new Date(entry.settlementDate),
            settlementSource: entry.source,
            paidFromAccountId: manifest.request.walletId,
            cashAmount: entry.amount,
            updatedAt: recordedAt,
          })
          .where(
            and(
              eq(transactions.userId, manifest.request.userId),
              eq(transactions.id, entry.transactionId),
            ),
          );
      }
      await db
        .update(accounts)
        .set({ cashAnchorBasis: 'effective' })
        .where(
          and(
            eq(accounts.id, manifest.request.walletId),
            eq(accounts.userId, manifest.request.userId),
          ),
        );
      const after = (
        await new WalletCashService(db).getWalletCash(manifest.request.userId)
      ).wallets.find((w) => w.id === manifest.request.walletId);
      if (!after || Money.fromNumber(after.cash, 'BRL').toDbString() !== before.cash)
        throw new Error('HISTORICAL_CUTOVER_CHANGES_CASH');
      await new AuditService(db).log(
        manifest.request.userId,
        'historical_settlement',
        'account',
        manifest.request.walletId,
        {
          wallet: before.wallet,
          transactions: before.rows.filter((r) =>
            manifest.request.entries.some((e) => e.transactionId === r.id),
          ),
        },
        {
          afterHash: await new HistoricalSettlementService(db).stateHash(
            manifest.request.userId,
            manifest.request.walletId,
          ),
          manifestHash: hash,
          entries: manifest.request.entries,
          cashBefore: before.cash,
          cashAfter: before.cash,
          backupSha256: safety.backup.sha256,
        },
      );
      return {
        replayed: false,
        manifestHash: hash,
        cashBefore: before.cash,
        cashAfter: before.cash,
      };
    });
  }
  private async stateHash(userId: string, walletId: string) {
    const [wallet] = await this.db
      .select()
      .from(accounts)
      .where(and(eq(accounts.userId, userId), eq(accounts.id, walletId)));
    const rows = await this.db
      .select()
      .from(transactions)
      .where(
        and(
          eq(transactions.userId, userId),
          or(
            eq(transactions.sourceAccountId, walletId),
            eq(transactions.destinationAccountId, walletId),
            eq(transactions.paidFromAccountId, walletId),
          ),
        ),
      )
      .orderBy(transactions.id);
    return financialRevision({ wallet, rows });
  }
  private async appliedAudit(userId: string, walletId: string, hash: string) {
    const rows = await this.db
      .select()
      .from(auditLog)
      .where(
        and(
          eq(auditLog.userId, userId),
          eq(auditLog.entityId, walletId),
          eq(auditLog.action, 'historical_settlement'),
        ),
      );
    const audit = rows.find(
      (r) =>
        r.newData &&
        typeof r.newData === 'object' &&
        'manifestHash' in r.newData &&
        r.newData.manifestHash === hash,
    );
    if (!audit) throw new Error('HISTORICAL_RECEIPT_REQUIRED');
    return audit;
  }
  async previewInverse(raw: unknown) {
    const manifest = historicalSettlementManifestSchema.parse(raw);
    const audit = await this.appliedAudit(
      manifest.request.userId,
      manifest.request.walletId,
      manifest.hash,
    );
    const after = z.object({ afterHash: z.string() }).parse(audit.newData);
    const snapshotHash = await this.stateHash(manifest.request.userId, manifest.request.walletId);
    if (snapshotHash !== after.afterHash) throw new Error('HISTORICAL_SNAPSHOT_CHANGED');
    const result = {
      version: 1 as const,
      kind: 'historical-settlements-inverse' as const,
      target: manifest.target,
      userId: manifest.request.userId,
      walletId: manifest.request.walletId,
      manifestHash: manifest.hash,
      snapshotHash,
      createdAt: new Date().toISOString(),
    };
    return { ...result, hash: financialRevision(result) };
  }
  async revert(raw: unknown, safety: Safety) {
    const inverse = historicalInverseSchema.parse(raw);
    await validateSafety(inverse, safety);
    return runWithMaterializationLock(this.db, inverse.userId, async ({ db }) => {
      const service = new HistoricalSettlementService(db);
      const prior = await db
        .select()
        .from(auditLog)
        .where(
          and(
            eq(auditLog.userId, inverse.userId),
            eq(auditLog.entityId, inverse.walletId),
            eq(auditLog.action, 'historical_settlement_revert'),
          ),
        );
      if (
        prior.some(
          (r) =>
            r.newData &&
            typeof r.newData === 'object' &&
            'inverseHash' in r.newData &&
            r.newData.inverseHash === inverse.hash,
        )
      )
        return { replayed: true, inverseHash: inverse.hash };
      if ((await service.stateHash(inverse.userId, inverse.walletId)) !== inverse.snapshotHash)
        throw new Error('HISTORICAL_SNAPSHOT_CHANGED');
      const audit = await service.appliedAudit(
        inverse.userId,
        inverse.walletId,
        inverse.manifestHash,
      );
      const before = beforeSchema.parse(audit.previousData);
      const [wallet] = await db
        .select()
        .from(accounts)
        .where(and(eq(accounts.userId, inverse.userId), eq(accounts.id, inverse.walletId)));
      if (!wallet?.openingBalanceAnchorAt) throw new Error('HISTORICAL_SNAPSHOT_CHANGED');
      await assertOpenSettlementPeriods(db, inverse.userId, [
        settlementDateKey(wallet.openingBalanceAnchorAt),
      ]);
      const current = await new WalletCashService(db).getWalletCash(inverse.userId);
      const rows = await db
        .select()
        .from(transactions)
        .where(eq(transactions.userId, inverse.userId));
      for (const entry of before.transactions) {
        const row = rows.find((r) => r.id === entry.id);
        if (!row) throw new Error('HISTORICAL_SNAPSHOT_CHANGED');
        await assertNoPayrollAllocation(db, inverse.userId, row.id);
        await assertOpenSettlementPeriods(db, inverse.userId, [
          row.date.toISOString().slice(0, 10),
          settlementDateKey(row.settlementDate ?? row.date),
        ]);
        const { id, ...fields } = entry;
        await db
          .update(transactions)
          .set(fields)
          .where(and(eq(transactions.id, id), eq(transactions.userId, inverse.userId)));
      }
      await db
        .update(accounts)
        .set({ cashAnchorBasis: before.wallet.cashAnchorBasis })
        .where(and(eq(accounts.id, inverse.walletId), eq(accounts.userId, inverse.userId)));
      const after = await new WalletCashService(db).getWalletCash(inverse.userId);
      if (
        financialRevision(current.wallets.map((w) => ({ id: w.id, cash: w.cash }))) !==
        financialRevision(after.wallets.map((w) => ({ id: w.id, cash: w.cash })))
      )
        throw new Error('HISTORICAL_INVERSE_CHANGES_CASH');
      await new AuditService(db).log(
        inverse.userId,
        'historical_settlement_revert',
        'account',
        inverse.walletId,
        null,
        {
          inverseHash: inverse.hash,
          manifestHash: inverse.manifestHash,
          backupSha256: safety.backup.sha256,
        },
      );
      return { replayed: false, inverseHash: inverse.hash };
    });
  }
}
