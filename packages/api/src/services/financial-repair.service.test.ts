import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import type { DbExecutor } from '@fc/db';
import {
  accounts,
  auditLog,
  creditCardBills,
  faturaImports,
  faturaMatchRules,
  monthClosings,
  scheduledTransactions,
  transactions,
  userProfiles,
} from '@fc/db';
import { and, eq, sql } from 'drizzle-orm';
import { afterEach, describe, expect, it } from 'vitest';
import { resolveDatabaseTarget } from '../../../../scripts/lib/database-target.ts';
import { withRollback } from '../test/with-rollback.ts';
import {
  type BankEvidence,
  createFinancialRepairInverse,
  type FinancialManifest,
  FinancialRepairService,
  financialManifestHash,
  type RepairSafety,
  reviewFinancialManifest,
  reviewFinancialRepairInverse,
} from './financial-repair.service.ts';
import {
  createStatementInverse,
  reviewStatementInverse,
  reviewStatementManifest,
  StatementRepairService,
} from './statement-repair.service.ts';
import { WalletCashService } from './wallet-cash.service.ts';

const target = 'a'.repeat(64);
const temporaryFolders: string[] = [];
afterEach(async () => {
  await Promise.all(
    temporaryFolders.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  );
});
async function repairSafety(manifest: Pick<FinancialManifest, 'scope'>): Promise<RepairSafety> {
  const dir = await mkdtemp(join(tmpdir(), 'fc-repair-'));
  temporaryFolders.push(dir);
  const file = join(dir, 'backup.dump');
  const data = 'test archive; pg_dump integrity is covered by maintenance integration';
  await writeFile(file, data);
  return {
    targetFingerprint: target,
    confirmTarget: target,
    expectedManifestHash: financialManifestHash(manifest),
    userId: manifest.scope.userId,
    fromPeriod: manifest.scope.fromPeriod,
    toPeriod: manifest.scope.toPeriod,
    producersPaused: true,
    backup: {
      version: 1,
      target,
      file,
      sha256: createHash('sha256').update(data).digest('hex'),
      createdAt: new Date().toISOString(),
    },
  };
}
async function seedRepair(db: DbExecutor) {
  const [user] = await db
    .insert(userProfiles)
    .values({ email: `repair-${randomUUID()}@test.local`, name: 'Repair test', passwordHash: 'x' })
    .returning();
  const [wallet] = await db
    .insert(accounts)
    .values({
      userId: user.id,
      name: 'Bank',
      type: 'checking',
      currency: 'BRL',
      openingBalance: '1000.00',
      openingBalanceAnchorAt: new Date('2026-06-01T12:00:00Z'),
    })
    .returning();
  const [expense] = await db
    .insert(accounts)
    .values({ userId: user.id, name: 'Food', type: 'expense' })
    .returning();
  const [card] = await db
    .insert(accounts)
    .values({ userId: user.id, name: 'Card', type: 'credit_card' })
    .returning();
  const [charge] = await db
    .insert(transactions)
    .values({
      userId: user.id,
      sourceAccountId: expense.id,
      destinationAccountId: card.id,
      amount: '100.00',
      type: 'withdrawal',
      domainType: 'credit_card_expense',
      description: 'Synthetic charge',
      date: new Date('2026-07-10'),
      billingMonth: 7,
      billingYear: 2026,
      isPaid: true,
      paidAt: new Date('2026-07-20T15:00:00Z'),
      paidFromAccountId: wallet.id,
    })
    .returning();
  const [payment] = await db
    .insert(transactions)
    .values({
      userId: user.id,
      sourceAccountId: wallet.id,
      destinationAccountId: card.id,
      amount: '100.00',
      type: 'transfer',
      domainType: 'bill_payment',
      description: 'Synthetic payment',
      date: new Date('2026-07-20'),
      billingMonth: 7,
      billingYear: 2026,
    })
    .returning();
  const [bill] = await db
    .insert(creditCardBills)
    .values({
      creditCardAccountId: card.id,
      month: 7,
      year: 2026,
      totalAmount: '100.00',
      paidAmount: '100.00',
      status: 'paid',
      paidAt: new Date('2026-07-20T15:00:00Z'),
    })
    .returning();
  const scope = {
    userId: user.id,
    cardAccountIds: [card.id],
    fromPeriod: '2026-07',
    toPeriod: '2026-07',
  };
  const evidence: BankEvidence = {
    transactionId: payment.id,
    statementSha256: 'b'.repeat(64),
    entryReference: 'entry-1',
    paymentDate: '2026-07-20',
    walletAccountId: wallet.id,
    amount: '100.00',
    includedInOpeningBalance: false,
    anchorStatementSha256: 'c'.repeat(64),
    openingBalance: '1000.00',
    anchorAt: '2026-06-01T12:00:00.000Z',
  };
  return {
    user,
    wallet,
    expense,
    card,
    charge,
    payment,
    bill,
    scope,
    evidence,
    service: new FinancialRepairService(db),
  };
}

describe('FinancialRepairService read-only diagnosis', () => {
  it('detects an unpaid bank transfer without treating the paid bill as bank evidence', async () => {
    await withRollback(async (db) => {
      const f = await seedRepair(db);
      const before = await db.select().from(transactions).where(eq(transactions.userId, f.user.id));
      await db.execute(sql`SET LOCAL transaction_read_only = on`);
      const manifest = await f.service.audit(f.scope, target);
      expect(manifest).toMatchObject({
        status: 'draft',
        cashReconciled: false,
        anchorPolicy: 'preserve',
        expectedDeltaByWalletPeriod: [],
      });
      expect(manifest.entries).toHaveLength(1);
      expect(manifest.entries[0]).toMatchObject({
        transactionId: f.payment.id,
        decision: 'pending',
        reasons: ['bank-evidence-required'],
        evidence: null,
      });
      expect(manifest.entries[0].before.wallet?.cashAnchorBasis).toBe('recorded');
      expect(manifest.entries[0].before.payments[0]).toMatchObject({
        cashAmount: null,
        settlementDate: null,
        settlementSource: 'legacy',
      });
      expect(manifest.entries[0].beforeHash).toMatch(/^[a-f0-9]{64}$/);
      expect(
        await db.select().from(transactions).where(eq(transactions.userId, f.user.id)),
      ).toEqual(before);
      expect((await new WalletCashService(db).getWalletCash(f.user.id)).totalCash).toBe(1000);
    });
  });

  it('seals only a matching evidenced payment and retains the original recorded settlement time', async () => {
    await withRollback(async (db) => {
      const f = await seedRepair(db);
      const draft = await f.service.audit(f.scope, target);
      const reviewed = reviewFinancialManifest(draft, [f.evidence], 'Test reviewer');
      expect(reviewed.entries[0]).toMatchObject({
        decision: 'apply',
        proposal: {
          isPaid: true,
          paidAt: '2026-07-20T15:00:00.000Z',
          paidFromAccountId: f.wallet.id,
        },
      });
      expect(reviewed.expectedDeltaByWalletPeriod).toEqual([
        { walletAccountId: f.wallet.id, period: '2026-07', amount: '-100.00' },
      ]);
      expect(financialManifestHash(reviewed)).not.toBe(financialManifestHash(draft));
      expect(draft.status).toBe('draft');
    });
  });

  it.each([
    'included',
    'wrong-wallet',
    'wrong-amount',
    'wrong-date',
    'wrong-anchor',
  ] as const)('refuses %s evidence', async (kind) => {
    await withRollback(async (db) => {
      const f = await seedRepair(db);
      const draft = await f.service.audit(f.scope, target);
      const evidence = {
        ...f.evidence,
        ...(kind === 'included'
          ? { includedInOpeningBalance: true }
          : kind === 'wrong-wallet'
            ? { walletAccountId: randomUUID() }
            : kind === 'wrong-amount'
              ? { amount: '99.00' }
              : kind === 'wrong-date'
                ? { paymentDate: '2026-07-21' }
                : { openingBalance: '900.00' }),
      };
      expect(() => reviewFinancialManifest(draft, [evidence], 'Reviewer')).toThrow(
        'REPAIR_EVIDENCE_MISMATCH',
      );
    });
  });

  it.each([
    'before-anchor',
    'unknown-date',
    'wrong-wallet',
    'reversed',
    'missing',
    'charges-unpaid',
  ] as const)('excludes %s data from automatic repair', async (kind) => {
    await withRollback(async (db) => {
      const f = await seedRepair(db);
      if (kind === 'before-anchor')
        await db
          .update(accounts)
          .set({ openingBalanceAnchorAt: new Date('2026-07-21T12:00:00Z') })
          .where(eq(accounts.id, f.wallet.id));
      if (kind === 'unknown-date')
        await db
          .update(creditCardBills)
          .set({ paidAt: null, paidAmount: '0.00' })
          .where(eq(creditCardBills.id, f.bill.id));
      if (kind === 'wrong-wallet')
        await db
          .update(transactions)
          .set({ sourceAccountId: f.expense.id })
          .where(eq(transactions.id, f.payment.id));
      if (kind === 'reversed')
        await db
          .update(transactions)
          .set({ isReversed: true })
          .where(eq(transactions.id, f.payment.id));
      if (kind === 'missing')
        await db.delete(transactions).where(eq(transactions.id, f.payment.id));
      if (kind === 'charges-unpaid')
        await db
          .update(transactions)
          .set({ isPaid: false })
          .where(eq(transactions.id, f.charge.id));
      const manifest = await f.service.audit(f.scope, target);
      expect(manifest.entries[0].decision).toBe('exclude');
      expect(manifest.entries[0].reasons.length).toBeGreaterThan(0);
      expect(() => reviewFinancialManifest(manifest, [f.evidence], 'Reviewer')).toThrow();
    });
  });

  it('detects a reversed predecessor even when a pending replacement exists', async () => {
    await withRollback(async (db) => {
      const f = await seedRepair(db);
      await db.insert(transactions).values({ ...f.payment, id: randomUUID(), isReversed: true });
      const manifest = await f.service.audit(f.scope, target);
      expect(manifest.entries[0].reasons).toContain('reversed-payment-history');
    });
  });

  it('detects changed state and enforces account ownership and a bounded period', async () => {
    await withRollback(async (db) => {
      const f = await seedRepair(db);
      const first = await f.service.audit(f.scope, target);
      await db
        .update(transactions)
        .set({ amount: '101.00' })
        .where(and(eq(transactions.id, f.payment.id), eq(transactions.userId, f.user.id)));
      const next = await f.service.audit(f.scope, target);
      expect(next.entries[0].beforeHash).not.toBe(first.entries[0].beforeHash);
      await expect(f.service.audit({ ...f.scope, userId: randomUUID() }, target)).rejects.toThrow(
        'REPAIR_ACCOUNT_SCOPE_INVALID',
      );
      await expect(
        f.service.audit({ ...f.scope, fromPeriod: '2026-08' }, target),
      ).rejects.toThrow();
    });
  });
});

describe('FinancialRepairService controlled application and recovery', () => {
  it.each([
    'cash',
    'cycles',
  ] as const)('previews %s from the CLI without connecting to the unreachable database or printing financial data', async (kind) => {
    await withRollback(async (db) => {
      const f = await seedRepair(db);
      const environment = {
        ...process.env,
        DATABASE_URL: 'postgresql://postgres:do-not-print@localhost:1/preview_test',
      };
      const resolved = resolveDatabaseTarget(environment);
      const manifest =
        kind === 'cycles'
          ? await f.service.auditStatementCycles(f.scope, resolved.fingerprint)
          : await f.service.audit(f.scope, resolved.fingerprint);
      const folder = await mkdtemp(join(tmpdir(), 'fc-repair-cli-'));
      temporaryFolders.push(folder);
      const file = join(folder, 'manifest.json');
      await writeFile(file, JSON.stringify(manifest));
      const { stdout, stderr } = await promisify(execFile)(
        process.execPath,
        [
          join(process.cwd(), '../../node_modules/tsx/dist/cli.mjs'),
          'src/scripts/apply-financial-repair.ts',
          '--manifest',
          file,
        ],
        { cwd: process.cwd(), env: environment, timeout: 30_000 },
      );
      expect(JSON.parse(stdout)).toMatchObject({
        status: 'preview',
        databaseChanged: false,
        pending: 1,
      });
      expect(stdout + stderr).not.toContain('do-not-print');
      expect(stdout + stderr).not.toContain(f.user.id);
      expect(stdout + stderr).not.toContain('1000.00');
    });
  }, 45_000);

  it('applies once, persists a receipt and restores only the reviewed payment on inverse replay', async () => {
    await withRollback(async (db) => {
      const f = await seedRepair(db);
      const manifest = reviewFinancialManifest(
        await f.service.audit(f.scope, target),
        [f.evidence],
        'Reviewer',
      );
      const safety = await repairSafety(manifest);
      const result = await f.service.apply(manifest, safety);
      expect(result.status).toBe('applied');
      expect(result.receipt.changes[0].after.payments[0]).toMatchObject({
        cashAmount: '100.00',
        settlementSource: 'bank',
        settlementDate: '2026-07-20T15:00:00.000Z',
      });
      expect((await new WalletCashService(db).getWalletCash(f.user.id)).totalCash).toBe(900);
      expect((await f.service.apply(manifest, safety)).status).toBe('already-applied');
      const [charge] = await db.select().from(transactions).where(eq(transactions.id, f.charge.id));
      const [bill] = await db
        .select()
        .from(creditCardBills)
        .where(eq(creditCardBills.id, f.bill.id));
      expect(charge).toEqual(f.charge);
      expect(bill).toEqual(f.bill);
      const inverse = reviewFinancialRepairInverse(
        createFinancialRepairInverse(result.receipt),
        'Reviewer',
      );
      const recovery = {
        ...(await repairSafety(manifest)),
        expectedInverseHash: financialManifestHash(inverse),
      };
      expect((await f.service.revert(manifest, inverse, recovery)).status).toBe('reverted');
      const [restoredPayment] = await db
        .select()
        .from(transactions)
        .where(eq(transactions.id, f.payment.id));
      expect(restoredPayment).toMatchObject({
        amount: f.payment.amount,
        currency: f.payment.currency,
        cashAmount: f.payment.cashAmount,
        settlementSource: f.payment.settlementSource,
        settlementDate: f.payment.settlementDate,
      });
      expect((await new WalletCashService(db).getWalletCash(f.user.id)).totalCash).toBe(1000);
      expect((await f.service.revert(manifest, inverse, recovery)).status).toBe('already-reverted');
      await expect(f.service.apply(manifest, safety)).rejects.toThrow('REPAIR_ALREADY_REVERTED');
      const log = await db
        .select()
        .from(auditLog)
        .where(and(eq(auditLog.userId, f.user.id), eq(auditLog.entityType, 'financial_repair')));
      expect(log).toHaveLength(2);
    });
  });

  it.each([
    'hash',
    'target',
    'scope',
    'not-paused',
    'backup',
    'draft',
  ] as const)('rejects unsafe %s before writes', async (kind) => {
    await withRollback(async (db) => {
      const f = await seedRepair(db);
      const draft = await f.service.audit(f.scope, target);
      const manifest =
        kind === 'draft' ? draft : reviewFinancialManifest(draft, [f.evidence], 'Reviewer');
      const safety = await repairSafety(manifest);
      if (kind === 'hash') safety.expectedManifestHash = 'd'.repeat(64);
      if (kind === 'target') safety.confirmTarget = 'd'.repeat(64);
      if (kind === 'scope') safety.userId = randomUUID();
      if (kind === 'not-paused') safety.producersPaused = false;
      if (kind === 'backup') await writeFile(safety.backup.file, 'corrupt');
      await expect(f.service.apply(manifest, safety)).rejects.toThrow(/^(REPAIR_|DATABASE_)/);
      expect(
        (await db.select().from(transactions).where(eq(transactions.id, f.payment.id)))[0],
      ).toEqual(f.payment);
      expect(await db.select().from(auditLog).where(eq(auditLog.userId, f.user.id))).toHaveLength(
        0,
      );
    });
  });

  it.each([
    'payment',
    'bill',
    'charge',
    'anchor',
  ] as const)('aborts when %s changes after diagnosis', async (kind) => {
    await withRollback(async (db) => {
      const f = await seedRepair(db);
      const manifest = reviewFinancialManifest(
        await f.service.audit(f.scope, target),
        [f.evidence],
        'Reviewer',
      );
      const safety = await repairSafety(manifest);
      if (kind === 'payment')
        await db
          .update(transactions)
          .set({ description: 'Another edit' })
          .where(eq(transactions.id, f.payment.id));
      if (kind === 'bill')
        await db
          .update(creditCardBills)
          .set({ totalAmount: '101.00' })
          .where(eq(creditCardBills.id, f.bill.id));
      if (kind === 'charge')
        await db
          .update(transactions)
          .set({ amount: '101.00' })
          .where(eq(transactions.id, f.charge.id));
      if (kind === 'anchor')
        await db
          .update(accounts)
          .set({ openingBalance: '900.00' })
          .where(eq(accounts.id, f.wallet.id));
      await expect(f.service.apply(manifest, safety)).rejects.toThrow('REPAIR_STATE_CHANGED');
      expect(
        (await db.select().from(transactions).where(eq(transactions.id, f.payment.id)))[0].isPaid,
      ).toBe(false);
    });
  });

  it('refuses reversal after a third-party edit and preserves that edit', async () => {
    await withRollback(async (db) => {
      const f = await seedRepair(db);
      const manifest = reviewFinancialManifest(
        await f.service.audit(f.scope, target),
        [f.evidence],
        'Reviewer',
      );
      const safety = await repairSafety(manifest);
      const result = await f.service.apply(manifest, safety);
      const inverse = reviewFinancialRepairInverse(
        createFinancialRepairInverse(result.receipt),
        'Reviewer',
      );
      await db
        .update(transactions)
        .set({ description: 'Concurrent edit to preserve' })
        .where(eq(transactions.id, f.payment.id));
      await expect(
        f.service.revert(manifest, inverse, {
          ...(await repairSafety(manifest)),
          expectedInverseHash: financialManifestHash(inverse),
        }),
      ).rejects.toThrow('REPAIR_STATE_CHANGED');
      expect(
        (await db.select().from(transactions).where(eq(transactions.id, f.payment.id)))[0],
      ).toMatchObject({ isPaid: true, description: 'Concurrent edit to preserve' });
    });
  });

  it('aborts the entire batch when another payment changes, leaving the first pending', async () => {
    await withRollback(async (db) => {
      const f = await seedRepair(db);
      const [card] = await db
        .insert(accounts)
        .values({ userId: f.user.id, name: 'Second card', type: 'credit_card' })
        .returning();
      await db
        .insert(transactions)
        .values({ ...f.charge, id: randomUUID(), destinationAccountId: card.id });
      const [payment] = await db
        .insert(transactions)
        .values({ ...f.payment, id: randomUUID(), destinationAccountId: card.id })
        .returning();
      await db
        .insert(creditCardBills)
        .values({ ...f.bill, id: randomUUID(), creditCardAccountId: card.id });
      const scope = { ...f.scope, cardAccountIds: [f.card.id, card.id] };
      const manifest = reviewFinancialManifest(
        await f.service.audit(scope, target),
        [f.evidence, { ...f.evidence, transactionId: payment.id, entryReference: 'entry-2' }],
        'Reviewer',
      );
      const safety = await repairSafety(manifest);
      await db
        .update(transactions)
        .set({ amount: '110.00' })
        .where(eq(transactions.id, payment.id));
      await expect(f.service.apply(manifest, safety)).rejects.toThrow('REPAIR_STATE_CHANGED');
      expect(
        (await db.select().from(transactions).where(eq(transactions.id, f.payment.id)))[0].isPaid,
      ).toBe(false);
      expect((await new WalletCashService(db).getWalletCash(f.user.id)).totalCash).toBe(1000);
    });
  });

  it('rejects a tampered proposal even when its file hash was recomputed', async () => {
    await withRollback(async (db) => {
      const f = await seedRepair(db);
      const manifest = reviewFinancialManifest(
        await f.service.audit(f.scope, target),
        [f.evidence],
        'Reviewer',
      );
      if (!manifest.entries[0].proposal) throw new Error('Expected proposal');
      manifest.entries[0].proposal.paidAt = new Date().toISOString();
      await expect(f.service.apply(manifest, await repairSafety(manifest))).rejects.toThrow(
        'REPAIR_PROPOSAL_MISMATCH',
      );
    });
  });
});

describe('statement cycle repair', () => {
  async function fixture(db: DbExecutor) {
    const f = await seedRepair(db);
    const [imported] = await db
      .insert(faturaImports)
      .values({
        userId: f.user.id,
        cardAccountId: f.card.id,
        billingMonth: 7,
        billingYear: 2026,
        dueDate: '2026-07-20',
        status: 'applied',
        appliedAt: new Date('2026-07-15'),
        profileId: 'generic',
        modelUsed: 'legacy',
        parsedTotal: '100.00',
        statedTotal: '100.00',
        itemsJson: {
          cardAccounts: [{ id: f.card.id, name: 'Card', parentAccountId: null }],
          matchResult: { matched: [], review: [], newOnFatura: [], missingInSystem: [] },
          suggestions: [],
          totals: {
            chargesTotal: '100.00',
            refundsTotal: '0.00',
            netTotal: '100.00',
            delta: '0.00',
          },
        },
      })
      .returning();
    const scope = { ...f.scope, fromPeriod: '2026-06' };
    const service = new StatementRepairService(db);
    const evidence = {
      importId: imported.id,
      statementSha256: 'b'.repeat(64),
      entryReference: 'full statement page 1',
      closingDate: '2026-06-24',
      dueDate: '2026-07-20',
      chargeIds: [f.charge.id],
    };
    return { ...f, imported, scope, cycleService: service, cycleEvidence: evidence };
  }
  it('audits applied imports and performs an evidenced cycle move without changing payments, totals or cash; replays and reverts', async () => {
    await withRollback(async (db) => {
      const f = await fixture(db);
      const before = await db
        .select()
        .from(transactions)
        .where(eq(transactions.userId, f.user.id))
        .orderBy(transactions.id);
      const draft = await f.service.auditStatementCycles(f.scope, target);
      expect(draft.groups.find((g) => g.importIds.includes(f.imported.id))).toMatchObject({
        compositionDelta: '0.00',
        paymentIds: [f.payment.id],
      });
      const manifest = reviewStatementManifest(draft, [f.cycleEvidence], 'Test reviewer');
      const safety = await repairSafety(manifest);
      const result = await f.cycleService.apply(manifest, safety);
      expect(result.status).toBe('applied');
      expect(result.receipt.mapping).toContainEqual({
        cardAccountId: f.card.id,
        from: '2026-07',
        to: '2026-06',
        importId: f.imported.id,
      });
      expect(result.receipt.invariantsBefore).toEqual(result.receipt.invariantsAfter);
      const after = await db
        .select()
        .from(transactions)
        .where(eq(transactions.userId, f.user.id))
        .orderBy(transactions.id);
      expect(after).toHaveLength(before.length);
      for (const row of after) {
        const prior = before.find((t) => t.id === row.id);
        expect(row).toMatchObject({
          amount: prior?.amount,
          date: prior?.date,
          isPaid: prior?.isPaid,
          paidAt: prior?.paidAt,
          paidFromAccountId: prior?.paidFromAccountId,
          billingMonth: 6,
        });
      }
      const [bill] = await db
        .select()
        .from(creditCardBills)
        .where(eq(creditCardBills.id, f.bill.id));
      expect(bill).toMatchObject({
        month: 6,
        closingDate: '2026-06-24',
        dueDate: '2026-07-20',
        status: 'paid',
      });
      expect((await f.cycleService.apply(manifest, await repairSafety(manifest))).status).toBe(
        'already-applied',
      );
      const inverse = reviewStatementInverse(
        createStatementInverse(result.receipt),
        'Test reviewer',
      );
      expect(
        (
          await f.cycleService.revert(manifest, inverse, {
            ...(await repairSafety(manifest)),
            expectedInverseHash: financialManifestHash(inverse),
          })
        ).status,
      ).toBe('reverted');
      expect(
        (await db.select().from(creditCardBills).where(eq(creditCardBills.id, f.bill.id)))[0],
      ).toMatchObject({ month: 7, closingDate: null, dueDate: null });
      expect((await new WalletCashService(db).getWalletCash(f.user.id)).totalCash).toBe(1000);
    });
  });
  it('preserves series, learned rules and multiple installments in one cycle during metadata backfill', async () => {
    await withRollback(async (db) => {
      const f = await fixture(db);
      const [schedule] = await db
        .insert(scheduledTransactions)
        .values({
          userId: f.user.id,
          sourceAccountId: f.expense.id,
          destinationAccountId: f.card.id,
          amount: '50.00',
          description: 'Series',
          frequency: 'monthly',
          startDate: new Date('2026-05-01'),
          domainType: 'credit_card_installment',
          totalOccurrences: 10,
          startingOccurrence: 3,
        })
        .returning();
      await db
        .update(transactions)
        .set({
          scheduledTransactionId: schedule.id,
          domainType: 'credit_card_installment',
          amount: '50.00',
          installmentNumber: 3,
          totalInstallments: 10,
        })
        .where(eq(transactions.id, f.charge.id));
      const [second] = await db
        .insert(transactions)
        .values({
          userId: f.user.id,
          sourceAccountId: f.expense.id,
          destinationAccountId: f.card.id,
          amount: '50.00',
          description: 'Series',
          type: 'withdrawal',
          domainType: 'credit_card_installment',
          date: new Date('2026-07-11'),
          billingMonth: 7,
          billingYear: 2026,
          scheduledTransactionId: schedule.id,
          installmentNumber: 4,
          totalInstallments: 10,
        })
        .returning();
      const [rule] = await db
        .insert(faturaMatchRules)
        .values({
          userId: f.user.id,
          cardAccountId: f.card.id,
          rawNormalized: 'SERIES',
          targetScheduleId: schedule.id,
        })
        .returning();
      const draft = await f.cycleService.audit(f.scope, target);
      const group = draft.groups.find((g) => g.importIds.includes(f.imported.id));
      expect(group?.reasons).toContain('starting-occurrence-needs-review');
      expect(group?.ruleIds).toEqual([rule.id]);
      expect(group?.schedules[0]?.remainingRows).toBe(1);
      const evidence = { ...f.cycleEvidence, chargeIds: [f.charge.id, second.id] };
      expect(() => reviewStatementManifest(draft, [evidence], 'Test')).toThrow(
        'REPAIR_SERIES_OR_FAMILY_REVIEW_REQUIRED',
      );
      const manifest = reviewStatementManifest(
        draft,
        [{ ...evidence, closingDate: '2026-07-10' }],
        'Test',
      );
      const before = await db
        .select()
        .from(transactions)
        .where(eq(transactions.userId, f.user.id))
        .orderBy(transactions.id);
      const result = await f.cycleService.apply(manifest, await repairSafety(manifest));
      expect(result.receipt.patches.map((p) => p.entity)).toEqual(['bill', 'import']);
      expect(
        await db
          .select()
          .from(transactions)
          .where(eq(transactions.userId, f.user.id))
          .orderBy(transactions.id),
      ).toEqual(before);
      expect(
        (
          await db
            .select()
            .from(scheduledTransactions)
            .where(eq(scheduledTransactions.id, schedule.id))
        )[0],
      ).toEqual(schedule);
      expect(
        (await db.select().from(faturaMatchRules).where(eq(faturaMatchRules.id, rule.id)))[0],
      ).toEqual(rule);
    });
  });
  it('moves January to the documented December closing across years, with payment day unchanged', async () => {
    await withRollback(async (db) => {
      const f = await fixture(db),
        scope = { ...f.scope, fromPeriod: '2025-12', toPeriod: '2026-01' };
      await db
        .update(transactions)
        .set({ billingMonth: 1 })
        .where(eq(transactions.userId, f.user.id));
      await db.update(creditCardBills).set({ month: 1 }).where(eq(creditCardBills.id, f.bill.id));
      await db
        .update(faturaImports)
        .set({ billingMonth: 1, dueDate: '2026-01-08' })
        .where(eq(faturaImports.id, f.imported.id));
      const manifest = reviewStatementManifest(
        await f.cycleService.audit(scope, target),
        [{ ...f.cycleEvidence, closingDate: '2025-12-24', dueDate: '2026-01-08' }],
        'Test',
      );
      await f.cycleService.apply(manifest, await repairSafety(manifest));
      expect(
        (await db.select().from(transactions).where(eq(transactions.id, f.payment.id)))[0],
      ).toMatchObject({
        billingMonth: 12,
        billingYear: 2025,
        date: f.payment.date,
        amount: f.payment.amount,
        isPaid: f.payment.isPaid,
      });
    });
  });
  it.each([
    'hash',
    'target',
    'scope',
    'paused',
    'backup',
    'draft',
  ] as const)('rejects unsafe cycle repair %s without writes', async (kind) => {
    await withRollback(async (db) => {
      const f = await fixture(db),
        draft = await f.cycleService.audit(f.scope, target);
      const manifest =
        kind === 'draft' ? draft : reviewStatementManifest(draft, [f.cycleEvidence], 'Test');
      const safety = await repairSafety(manifest);
      if (kind === 'hash') safety.expectedManifestHash = 'd'.repeat(64);
      if (kind === 'target') safety.confirmTarget = 'd'.repeat(64);
      if (kind === 'scope') safety.userId = randomUUID();
      if (kind === 'paused') safety.producersPaused = false;
      if (kind === 'backup') await writeFile(safety.backup.file, 'corrupt');
      await expect(f.cycleService.apply(manifest, safety)).rejects.toThrow(/^(REPAIR_|DATABASE_)/);
      expect(
        (await db.select().from(creditCardBills).where(eq(creditCardBills.id, f.bill.id)))[0],
      ).toEqual(f.bill);
    });
  });
  it('blocks inconsistent persisted bill totals even when import and transaction totals match', async () => {
    await withRollback(async (db) => {
      const f = await fixture(db);
      await db
        .update(creditCardBills)
        .set({ totalAmount: '99.00' })
        .where(eq(creditCardBills.id, f.bill.id));
      const draft = await f.cycleService.audit(f.scope, target);
      expect(() => reviewStatementManifest(draft, [f.cycleEvidence], 'Test')).toThrow(
        'REPAIR_CYCLE_NOT_ELIGIBLE',
      );
    });
  });
  it('retains ambiguous totals, closed snapshots and target collisions for review', async () => {
    await withRollback(async (db) => {
      const f = await fixture(db);
      const source = await f.cycleService.audit(f.scope, target);
      await db
        .insert(creditCardBills)
        .values({ creditCardAccountId: f.card.id, month: 6, year: 2026, totalAmount: '1.00' });
      const collision = await f.cycleService.audit(f.scope, target);
      expect(() => reviewStatementManifest(collision, [f.cycleEvidence], 'Test')).toThrow(
        'REPAIR_CYCLE_COLLISION',
      );
      const stale = reviewStatementManifest(source, [f.cycleEvidence], 'Test');
      await expect(f.cycleService.apply(stale, await repairSafety(stale))).rejects.toThrow(
        'REPAIR_STATE_CHANGED',
      );
      await db
        .update(faturaImports)
        .set({ statedTotal: '101.00' })
        .where(eq(faturaImports.id, f.imported.id));
      const difference = await f.cycleService.audit(f.scope, target);
      expect(difference.groups.find((g) => g.importIds.includes(f.imported.id))).toMatchObject({
        compositionDelta: '-1.00',
      });
      expect(() => reviewStatementManifest(difference, [f.cycleEvidence], 'Test')).toThrow();
      await db
        .insert(monthClosings)
        .values({ userId: f.user.id, month: 7, year: 2026, status: 'closed' });
      const closed = await f.cycleService.audit(f.scope, target);
      expect(closed.groups.find((g) => g.importIds.includes(f.imported.id))?.reasons).toContain(
        'closed-snapshot',
      );
    });
  });
});
