import { createHash, randomUUID } from 'node:crypto';
import type { Database, DbExecutor } from '@fc/db';
import { accounts, auditLog, creditCardBills, transactions } from '@fc/db';
import { Money } from '@fc/domain';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { z } from 'zod';
import {
  type BackupReceipt,
  verifyBackupReceipt,
} from '../../../../scripts/lib/database-maintenance.ts';
import { acquireBillLocks } from '../lib/bill-lock.ts';
import { createCardWriteContext } from '../lib/card-write-context.ts';
import { runWithMaterializationLock } from '../lib/materialization-lock.ts';
import { AuditService } from './audit.service.ts';
import { BillService } from './bill.service.ts';
import { SettlementService } from './settlement.service.ts';
import { WalletCashService } from './wallet-cash.service.ts';

const hashSchema = z.string().regex(/^[a-f0-9]{64}$/);
const settlementSourceSchema = z.enum(['manual', 'bank', 'payroll', 'date_assumed', 'legacy']);
const amountSchema = z.string().regex(/^-?\d{1,10}\.\d{2}$/);
const daySchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .refine((v) => !Number.isNaN(Date.parse(v)) && new Date(v).toISOString().slice(0, 10) === v);
const periodSchema = z.string().regex(/^20\d{2}-(0[1-9]|1[0-2])$/);
const instantSchema = z.string().datetime();

function periodNumber(value: string) {
  return Number(value.slice(0, 4)) * 12 + Number(value.slice(5));
}

export const repairScopeSchema = z
  .object({
    userId: z.guid(),
    cardAccountIds: z.array(z.guid()).min(1).max(100),
    fromPeriod: periodSchema,
    toPeriod: periodSchema,
  })
  .strict()
  .refine(
    (v) =>
      new Set(v.cardAccountIds).size === v.cardAccountIds.length &&
      periodNumber(v.toPeriod) >= periodNumber(v.fromPeriod) &&
      periodNumber(v.toPeriod) - periodNumber(v.fromPeriod) < 120,
  );
export type RepairScope = z.infer<typeof repairScopeSchema>;

const accountSchema = z
  .object({
    id: z.guid(),
    userId: z.guid(),
    type: z.string(),
    currency: z.string(),
    isActive: z.boolean(),
    parentAccountId: z.guid().nullable(),
  })
  .strict();
const walletSchema = accountSchema
  .extend({
    openingBalance: amountSchema,
    openingBalanceAnchorAt: instantSchema.nullable(),
    cashAnchorBasis: z.enum(['recorded', 'effective']),
  })
  .strict();
const transactionSchema = z
  .object({
    id: z.guid(),
    userId: z.guid(),
    sourceAccountId: z.guid(),
    destinationAccountId: z.guid(),
    amount: amountSchema,
    currency: z.string(),
    type: z.string(),
    domainType: z.string().nullable(),
    date: daySchema,
    isPaid: z.boolean(),
    paidAt: instantSchema.nullable(),
    cashAmount: amountSchema.nullable(),
    settlementSource: settlementSourceSchema,
    settlementDate: instantSchema.nullable(),
    paidFromAccountId: z.guid().nullable(),
    isReversed: z.boolean(),
    reversesTransactionId: z.guid().nullable(),
    reversedByTransactionId: z.guid().nullable(),
    scheduledTransactionId: z.guid().nullable(),
    billingMonth: z.number().int().nullable(),
    billingYear: z.number().int().nullable(),
    rowHash: hashSchema,
  })
  .strict();
const billSchema = z
  .object({
    id: z.guid(),
    creditCardAccountId: z.guid(),
    month: z.number().int(),
    year: z.number().int(),
    totalAmount: amountSchema,
    paidAmount: amountSchema,
    status: z.string(),
    paidAt: instantSchema.nullable(),
    rowHash: hashSchema,
  })
  .strict();
const snapshotSchema = z
  .object({
    card: accountSchema,
    wallet: walletSchema.nullable(),
    bill: billSchema.nullable(),
    payments: z.array(transactionSchema),
    charges: z.array(transactionSchema),
  })
  .strict();
type RepairSnapshot = z.infer<typeof snapshotSchema>;

export const bankEvidenceSchema = z
  .object({
    transactionId: z.guid(),
    statementSha256: hashSchema,
    entryReference: z.string().trim().min(1).max(200),
    paymentDate: daySchema,
    walletAccountId: z.guid(),
    amount: amountSchema,
    includedInOpeningBalance: z.boolean(),
    anchorStatementSha256: hashSchema,
    openingBalance: amountSchema,
    anchorAt: instantSchema,
  })
  .strict();
export type BankEvidence = z.infer<typeof bankEvidenceSchema>;
const deltaSchema = z
  .object({ walletAccountId: z.guid(), period: periodSchema, amount: amountSchema })
  .strict();
const proposalSchema = z
  .object({ isPaid: z.literal(true), paidAt: instantSchema, paidFromAccountId: z.guid() })
  .strict();
const entrySchema = z
  .object({
    key: z.string(),
    transactionId: z.guid().nullable(),
    before: snapshotSchema,
    beforeHash: hashSchema,
    decision: z.enum(['pending', 'exclude', 'apply']),
    reasons: z.array(z.string()).min(0),
    evidence: bankEvidenceSchema.nullable(),
    proposal: proposalSchema.nullable(),
    expectedDelta: deltaSchema.nullable(),
  })
  .strict();
export type RepairEntry = z.infer<typeof entrySchema>;
export const financialManifestSchema = z
  .object({
    version: z.literal(2),
    id: z.guid(),
    target: hashSchema,
    createdAt: instantSchema,
    asOf: instantSchema,
    scope: repairScopeSchema,
    anchorPolicy: z.literal('preserve'),
    cashReconciled: z.literal(false),
    status: z.enum(['draft', 'reviewed']),
    review: z
      .object({ by: z.string().trim().min(1).max(200), at: instantSchema })
      .strict()
      .nullable(),
    entries: z.array(entrySchema).max(1000),
    expectedDeltaByWalletPeriod: z.array(deltaSchema),
  })
  .strict();
export type FinancialManifest = z.infer<typeof financialManifestSchema>;
export type RepairSafety = {
  targetFingerprint: string;
  confirmTarget: string;
  expectedManifestHash: string;
  userId: string;
  fromPeriod: string;
  toPeriod: string;
  producersPaused: boolean;
  backup: BackupReceipt;
};
const receiptSchema = z
  .object({
    version: z.literal(2),
    manifestId: z.guid(),
    manifestHash: hashSchema,
    target: hashSchema,
    scope: repairScopeSchema,
    operation: z.enum(['apply', 'revert']),
    createdAt: instantSchema,
    backupSha256: hashSchema,
    changes: z
      .array(
        z
          .object({
            key: z.string(),
            transactionId: z.guid(),
            before: snapshotSchema,
            after: snapshotSchema,
            evidence: bankEvidenceSchema,
          })
          .strict(),
      )
      .min(1),
    cashBefore: z.record(z.string(), amountSchema),
    cashAfter: z.record(z.string(), amountSchema),
  })
  .strict();
export type FinancialRepairReceipt = z.infer<typeof receiptSchema>;
const inverseSchema = z
  .object({
    version: z.literal(2),
    manifestId: z.guid(),
    manifestHash: hashSchema,
    receiptHash: hashSchema,
    target: hashSchema,
    scope: repairScopeSchema,
    status: z.enum(['draft', 'reviewed']),
    review: z
      .object({ by: z.string().trim().min(1).max(200), at: instantSchema })
      .strict()
      .nullable(),
    operations: z
      .array(
        z
          .object({
            transactionId: z.guid(),
            expectedAfterHash: hashSchema,
            restore: z
              .object({
                isPaid: z.boolean(),
                paidAt: instantSchema.nullable(),
                cashAmount: amountSchema.nullable(),
                settlementSource: settlementSourceSchema,
                settlementDate: instantSchema.nullable(),
                paidFromAccountId: z.guid().nullable(),
              })
              .strict(),
          })
          .strict(),
      )
      .min(1),
  })
  .strict();
export type FinancialRepairInverse = z.infer<typeof inverseSchema>;

function canonical(value: unknown): string {
  if (value instanceof Date) return JSON.stringify(value.toISOString());
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (typeof value === 'object' && value !== null)
    return `{${Object.entries(value)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`)
      .join(',')}}`;
  return JSON.stringify(value);
}
export function financialManifestHash(value: unknown): string {
  return createHash('sha256').update(canonical(value)).digest('hex');
}

function accountState(row: typeof accounts.$inferSelect) {
  return {
    id: row.id,
    userId: row.userId,
    type: row.type,
    currency: row.currency,
    isActive: row.isActive,
    parentAccountId: row.parentAccountId,
  };
}
function transactionState(
  row: typeof transactions.$inferSelect,
): z.infer<typeof transactionSchema> {
  return {
    id: row.id,
    userId: row.userId,
    sourceAccountId: row.sourceAccountId,
    destinationAccountId: row.destinationAccountId,
    amount: row.amount,
    currency: row.currency,
    type: row.type,
    domainType: row.domainType,
    date: row.date.toISOString().slice(0, 10),
    isPaid: row.isPaid,
    paidAt: row.paidAt?.toISOString() ?? null,
    cashAmount: row.cashAmount,
    settlementSource: row.settlementSource,
    settlementDate: row.settlementDate?.toISOString() ?? null,
    paidFromAccountId: row.paidFromAccountId,
    isReversed: row.isReversed,
    reversesTransactionId: row.reversesTransactionId,
    reversedByTransactionId: row.reversedByTransactionId,
    scheduledTransactionId: row.scheduledTransactionId,
    billingMonth: row.billingMonth,
    billingYear: row.billingYear,
    rowHash: financialManifestHash(row),
  };
}
function billState(row: typeof creditCardBills.$inferSelect): z.infer<typeof billSchema> {
  return {
    id: row.id,
    creditCardAccountId: row.creditCardAccountId,
    month: row.month,
    year: row.year,
    totalAmount: row.totalAmount,
    paidAmount: row.paidAmount,
    status: row.status,
    paidAt: row.paidAt?.toISOString() ?? null,
    rowHash: financialManifestHash(row),
  };
}
function periodKey(year: number, month: number) {
  return `${year}-${String(month).padStart(2, '0')}`;
}
function anchorDay(instant: string) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Sao_Paulo',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date(instant));
}

function classify(before: RepairSnapshot, asOf: string): string[] {
  const active = before.payments.filter((t) => !t.isReversed);
  const reasons: string[] = [];
  if (active.length !== 1)
    reasons.push(active.length === 0 ? 'missing-active-payment' : 'multiple-active-payments');
  if (
    before.payments.some(
      (t) => t.isReversed || t.reversesTransactionId || t.reversedByTransactionId,
    )
  )
    reasons.push('reversed-payment-history');
  const payment = active[0];
  const { wallet, bill } = before;
  if (!bill || bill.status !== 'paid') reasons.push('bill-not-paid');
  if (!payment) return reasons;
  if (
    !wallet ||
    wallet.userId !== payment.userId ||
    wallet.type !== 'checking' ||
    !wallet.isActive ||
    wallet.currency !== 'BRL'
  )
    reasons.push('invalid-wallet');
  if (payment.currency !== 'BRL' || before.card.currency !== 'BRL')
    reasons.push('currency-mismatch');
  if (payment.isPaid) reasons.push('already-settled');
  if (
    payment.cashAmount !== null ||
    payment.settlementDate !== null ||
    payment.settlementSource !== 'legacy' ||
    payment.paidAt ||
    payment.paidFromAccountId ||
    payment.scheduledTransactionId ||
    payment.type !== 'transfer'
  )
    reasons.push('unexpected-transfer-state');
  if (!bill?.paidAt) reasons.push('unknown-payment-date');
  else if (
    bill.paidAt > asOf ||
    payment.date > asOf.slice(0, 10) ||
    bill.paidAt.slice(0, 10) !== payment.date
  )
    reasons.push('payment-date-mismatch');
  if (!wallet?.openingBalanceAnchorAt) reasons.push('unknown-anchor');
  else if (
    payment.date <= anchorDay(wallet.openingBalanceAnchorAt) ||
    (bill?.paidAt && bill.paidAt <= wallet.openingBalanceAnchorAt)
  )
    reasons.push('at-or-before-anchor');
  const activeCharges = before.charges.filter((t) => !t.isReversed);
  if (
    !activeCharges.length ||
    activeCharges.some(
      (t) => t.currency !== 'BRL' || (t.domainType !== 'credit_card_refund' && !t.isPaid),
    )
  )
    reasons.push('charge-state-mismatch');
  else if (
    bill &&
    (BillService.computeBillTotals(activeCharges, 'BRL').totalMoney.toDbString() !==
      bill.totalAmount ||
      bill.paidAmount !== payment.amount)
  )
    reasons.push('bill-amount-mismatch');
  return reasons;
}

function deltaTotals(entries: RepairEntry[]) {
  const totals = new Map<string, z.infer<typeof deltaSchema>>();
  for (const entry of entries.filter((e) => e.decision === 'apply')) {
    const delta = entry.expectedDelta;
    if (!delta) throw new Error('REPAIR_DELTA_MISSING');
    const key = `${delta.walletAccountId}:${delta.period}`;
    const existing = totals.get(key);
    totals.set(key, {
      ...delta,
      amount: Money.fromString(existing?.amount ?? '0', 'BRL')
        .add(Money.fromString(delta.amount, 'BRL'))
        .toDbString(),
    });
  }
  return [...totals.values()].sort((a, b) =>
    `${a.walletAccountId}:${a.period}`.localeCompare(`${b.walletAccountId}:${b.period}`),
  );
}

function validateEvidence(entry: RepairEntry, evidence: BankEvidence, asOf: string) {
  const payment = entry.before.payments.find((t) => t.id === entry.transactionId);
  const wallet = entry.before.wallet;
  if (
    classify(entry.before, asOf).length ||
    !payment ||
    !wallet ||
    evidence.transactionId !== payment.id ||
    evidence.walletAccountId !== wallet.id ||
    evidence.amount !== payment.amount ||
    evidence.paymentDate !== payment.date ||
    evidence.includedInOpeningBalance ||
    evidence.openingBalance !== wallet.openingBalance ||
    evidence.anchorAt !== wallet.openingBalanceAnchorAt
  )
    throw new Error('REPAIR_EVIDENCE_MISMATCH');
}

export function reviewFinancialManifest(
  input: unknown,
  evidenceInput: BankEvidence[],
  operator: string,
): FinancialManifest {
  const manifest = financialManifestSchema.parse(input);
  if (manifest.status !== 'draft') throw new Error('REPAIR_DRAFT_REQUIRED');
  const evidence = z.array(bankEvidenceSchema).min(1).parse(evidenceInput);
  const ids = new Set(evidence.map((e) => e.transactionId));
  const bankEntries = new Set(evidence.map((e) => `${e.statementSha256}:${e.entryReference}`));
  if (ids.size !== evidence.length || bankEntries.size !== evidence.length)
    throw new Error('REPAIR_EVIDENCE_REUSED');
  for (const item of evidence) {
    const entry = manifest.entries.find((e) => e.transactionId === item.transactionId);
    if (
      !entry ||
      entry.decision !== 'pending' ||
      entry.beforeHash !== financialManifestHash(entry.before)
    )
      throw new Error('REPAIR_ENTRY_NOT_ELIGIBLE');
    validateEvidence(entry, item, manifest.asOf);
    entry.decision = 'apply';
    entry.evidence = item;
    entry.reasons = [];
  }
  manifest.status = 'reviewed';
  manifest.review = { by: operator, at: new Date().toISOString() };
  manifest.expectedDeltaByWalletPeriod = deltaTotals(manifest.entries);
  return financialManifestSchema.parse(manifest);
}

export function validateFinancialRepair(
  input: unknown,
  expectedHash: string,
  target: string,
): FinancialManifest {
  const manifest = financialManifestSchema.parse(input);
  if (financialManifestHash(manifest) !== expectedHash)
    throw new Error('REPAIR_MANIFEST_HASH_MISMATCH');
  if (manifest.target !== target) throw new Error('REPAIR_TARGET_MISMATCH');
  if (manifest.status !== 'reviewed' || !manifest.review) throw new Error('REPAIR_REVIEW_REQUIRED');
  const selected = manifest.entries.filter((e) => e.decision === 'apply');
  if (!selected.length) throw new Error('REPAIR_NO_APPROVED_OPERATIONS');
  if (
    new Set(manifest.entries.map((e) => e.key)).size !== manifest.entries.length ||
    new Set(selected.map((e) => e.transactionId)).size !== selected.length ||
    new Set(selected.map((e) => `${e.evidence?.statementSha256}:${e.evidence?.entryReference}`))
      .size !== selected.length
  )
    throw new Error('REPAIR_DUPLICATE_OPERATION');
  for (const entry of selected) {
    const payment = entry.before.payments.find((p) => p.id === entry.transactionId);
    if (
      !entry.evidence ||
      !payment ||
      !entry.before.wallet ||
      !entry.before.bill?.paidAt ||
      entry.beforeHash !== financialManifestHash(entry.before)
    )
      throw new Error('REPAIR_ENTRY_NOT_ELIGIBLE');
    const period = periodKey(payment.billingYear ?? 0, payment.billingMonth ?? 0);
    if (
      payment.userId !== manifest.scope.userId ||
      !manifest.scope.cardAccountIds.includes(payment.destinationAccountId) ||
      period < manifest.scope.fromPeriod ||
      period > manifest.scope.toPeriod ||
      entry.key !== `${payment.destinationAccountId}:${period}`
    )
      throw new Error('REPAIR_SCOPE_MISMATCH');
    validateEvidence(entry, entry.evidence, manifest.asOf);
    const proposal = {
      isPaid: true,
      paidAt: entry.before.bill.paidAt,
      paidFromAccountId: entry.before.wallet.id,
    };
    const delta = {
      walletAccountId: entry.before.wallet.id,
      period: payment.date.slice(0, 7),
      amount: Money.zero('BRL').subtract(Money.fromString(payment.amount, 'BRL')).toDbString(),
    };
    if (
      financialManifestHash(proposal) !== financialManifestHash(entry.proposal) ||
      financialManifestHash(delta) !== financialManifestHash(entry.expectedDelta)
    )
      throw new Error('REPAIR_PROPOSAL_MISMATCH');
  }
  if (
    financialManifestHash(deltaTotals(manifest.entries)) !==
    financialManifestHash(manifest.expectedDeltaByWalletPeriod)
  )
    throw new Error('REPAIR_DELTA_MISMATCH');
  return manifest;
}

export function validateFinancialRepairRequest(
  input: unknown,
  safety: Omit<RepairSafety, 'backup'>,
) {
  const manifest = validateFinancialRepair(
    input,
    safety.expectedManifestHash,
    safety.targetFingerprint,
  );
  if (safety.confirmTarget !== manifest.target)
    throw new Error('REPAIR_TARGET_CONFIRMATION_REQUIRED');
  if (
    safety.userId !== manifest.scope.userId ||
    safety.fromPeriod !== manifest.scope.fromPeriod ||
    safety.toPeriod !== manifest.scope.toPeriod
  )
    throw new Error('REPAIR_SCOPE_MISMATCH');
  if (!safety.producersPaused) throw new Error('REPAIR_PRODUCERS_MUST_BE_PAUSED');
  return manifest;
}

async function validateSafety(input: unknown, safety: RepairSafety) {
  const manifest = validateFinancialRepairRequest(input, safety);
  await validateRepairBackup(manifest, safety.backup);
  return manifest;
}

export async function validateRepairBackup(
  manifest: { createdAt: string; target: string },
  backup: BackupReceipt,
) {
  const backupAt = Date.parse(backup.createdAt);
  if (
    !Number.isFinite(backupAt) ||
    backupAt < Date.parse(manifest.createdAt) ||
    Date.now() - backupAt > 15 * 60_000 ||
    backupAt > Date.now()
  )
    throw new Error('REPAIR_FRESH_BACKUP_REQUIRED');
  await verifyBackupReceipt(backup, { fingerprint: manifest.target });
}

async function cashForWallets(db: DbExecutor, manifest: FinancialManifest) {
  const overview = await new WalletCashService(db).getWalletCash(
    manifest.scope.userId,
    new Date(manifest.asOf),
  );
  const ids = new Set(manifest.expectedDeltaByWalletPeriod.map((d) => d.walletAccountId));
  return Object.fromEntries(
    overview.wallets
      .filter((w) => ids.has(w.id))
      .map((w) => [w.id, Money.fromString(w.cash.toFixed(2), 'BRL').toDbString()]),
  );
}

function assertCashDelta(
  before: Record<string, string>,
  after: Record<string, string>,
  manifest: FinancialManifest,
  revert: boolean,
) {
  const expected = new Map<string, Money>();
  for (const delta of manifest.expectedDeltaByWalletPeriod)
    expected.set(
      delta.walletAccountId,
      (expected.get(delta.walletAccountId) ?? Money.zero('BRL')).add(
        Money.fromString(delta.amount, 'BRL'),
      ),
    );
  for (const [id, amount] of expected) {
    if (before[id] === undefined || after[id] === undefined)
      throw new Error('REPAIR_CASH_DELTA_MISMATCH');
    const change = Money.fromString(after[id], 'BRL').subtract(Money.fromString(before[id], 'BRL'));
    if (change.toDbString() !== (revert ? Money.zero('BRL').subtract(amount) : amount).toDbString())
      throw new Error('REPAIR_CASH_DELTA_MISMATCH');
  }
}

export class FinancialRepairService {
  constructor(private db: DbExecutor) {}

  async auditStatementCycles(scope: RepairScope, target: string) {
    const { StatementRepairService } = await import('./statement-repair.service.ts');
    return new StatementRepairService(this.db).audit(scope, target);
  }

  async apply(
    input: unknown,
    safety: RepairSafety,
  ): Promise<{ status: 'applied' | 'already-applied'; receipt: FinancialRepairReceipt }> {
    const manifest = await validateSafety(input, safety);
    return this.withRepairLocks(manifest, async (tx) => {
      const prior = await this.receipt(tx, manifest, 'apply');
      if (await this.receipt(tx, manifest, 'revert')) throw new Error('REPAIR_ALREADY_REVERTED');
      const current = await new FinancialRepairService(tx).audit(manifest.scope, manifest.target);
      if (prior) {
        this.assertReceiptState(current, prior);
        return { status: 'already-applied', receipt: prior };
      }
      const entries = manifest.entries.filter((e) => e.decision === 'apply');
      for (const entry of entries) {
        if (current.entries.find((e) => e.key === entry.key)?.beforeHash !== entry.beforeHash)
          throw new Error('REPAIR_STATE_CHANGED');
      }
      const history = await tx
        .select()
        .from(auditLog)
        .where(
          and(
            eq(auditLog.userId, manifest.scope.userId),
            eq(auditLog.entityType, 'financial_repair'),
            eq(auditLog.action, 'financial_repair_apply'),
          ),
        );
      const used = new Set(
        history.flatMap((row) =>
          z
            .object({ changes: z.array(z.object({ evidence: bankEvidenceSchema })) })
            .parse(row.newData)
            .changes.map((c) => `${c.evidence.statementSha256}:${c.evidence.entryReference}`),
        ),
      );
      if (
        entries.some((entry) =>
          used.has(`${entry.evidence?.statementSha256}:${entry.evidence?.entryReference}`),
        )
      )
        throw new Error('REPAIR_EVIDENCE_REUSED');
      const cashBefore = await cashForWallets(tx, manifest);
      for (const entry of entries) {
        if (!entry.transactionId || !entry.proposal) throw new Error('REPAIR_ENTRY_NOT_ELIGIBLE');
        await new SettlementService(tx).settleBillPayment(
          createCardWriteContext(manifest.scope.userId),
          manifest.scope.userId,
          {
            transactionId: entry.transactionId,
            walletAccountId: entry.proposal.paidFromAccountId,
            settledAt: new Date(entry.proposal.paidAt),
            settlementSource: 'bank',
          },
        );
      }
      const after = await new FinancialRepairService(tx).audit(manifest.scope, manifest.target);
      const cashAfter = await cashForWallets(tx, manifest);
      assertCashDelta(cashBefore, cashAfter, manifest, false);
      const receipt = receiptSchema.parse({
        version: 2,
        manifestId: manifest.id,
        manifestHash: safety.expectedManifestHash,
        target: manifest.target,
        scope: manifest.scope,
        operation: 'apply',
        createdAt: new Date().toISOString(),
        backupSha256: safety.backup.sha256,
        cashBefore,
        cashAfter,
        changes: entries.map((entry) => ({
          key: entry.key,
          transactionId: entry.transactionId,
          before: entry.before,
          after: after.entries.find((e) => e.key === entry.key)?.before,
          evidence: entry.evidence,
        })),
      });
      await new AuditService(tx).log(
        manifest.scope.userId,
        'financial_repair_apply',
        'financial_repair',
        manifest.id,
        undefined,
        receipt,
      );
      return { status: 'applied', receipt };
    });
  }

  async revert(
    input: unknown,
    inverseInput: unknown,
    safety: RepairSafety & { expectedInverseHash: string },
  ): Promise<{ status: 'reverted' | 'already-reverted'; receipt: FinancialRepairReceipt }> {
    const manifest = await validateSafety(input, safety);
    const inverse = inverseSchema.parse(inverseInput);
    if (
      inverse.status !== 'reviewed' ||
      !inverse.review ||
      financialManifestHash(inverse) !== safety.expectedInverseHash
    )
      throw new Error('REPAIR_INVERSE_REVIEW_REQUIRED');
    return this.withRepairLocks(manifest, async (tx) => {
      const original = await this.receipt(tx, manifest, 'apply');
      if (!original) throw new Error('REPAIR_APPLY_RECEIPT_REQUIRED');
      const expected = createFinancialRepairInverse(original);
      if (
        financialManifestHash({ ...inverse, status: 'draft', review: null }) !==
        financialManifestHash(expected)
      )
        throw new Error('REPAIR_INVERSE_MISMATCH');
      const current = await new FinancialRepairService(tx).audit(manifest.scope, manifest.target);
      const prior = await this.receipt(tx, manifest, 'revert');
      if (prior) {
        this.assertReceiptState(current, prior);
        return { status: 'already-reverted', receipt: prior };
      }
      if (safety.backup.createdAt < original.createdAt)
        throw new Error('REPAIR_FRESH_BACKUP_REQUIRED');
      this.assertReceiptState(current, original);
      const cashBefore = await cashForWallets(tx, manifest);
      for (const operation of inverse.operations) {
        const [restored] = await tx
          .update(transactions)
          .set({
            ...operation.restore,
            paidAt: operation.restore.paidAt ? new Date(operation.restore.paidAt) : null,
            settlementDate: operation.restore.settlementDate
              ? new Date(operation.restore.settlementDate)
              : null,
            updatedAt: new Date(),
          })
          .where(
            and(
              eq(transactions.id, operation.transactionId),
              eq(transactions.userId, manifest.scope.userId),
            ),
          )
          .returning({ id: transactions.id });
        if (!restored) throw new Error('REPAIR_STATE_CHANGED');
      }
      const after = await new FinancialRepairService(tx).audit(manifest.scope, manifest.target);
      const cashAfter = await cashForWallets(tx, manifest);
      assertCashDelta(cashBefore, cashAfter, manifest, true);
      const receipt = receiptSchema.parse({
        ...original,
        operation: 'revert',
        createdAt: new Date().toISOString(),
        backupSha256: safety.backup.sha256,
        cashBefore,
        cashAfter,
        changes: original.changes.map((change) => ({
          ...change,
          before: change.after,
          after: after.entries.find((e) => e.key === change.key)?.before,
        })),
      });
      await new AuditService(tx).log(
        manifest.scope.userId,
        'financial_repair_revert',
        'financial_repair',
        manifest.id,
        undefined,
        receipt,
      );
      return { status: 'reverted', receipt };
    });
  }

  private async receipt(
    db: DbExecutor,
    manifest: FinancialManifest,
    operation: 'apply' | 'revert',
  ) {
    const rows = await db
      .select()
      .from(auditLog)
      .where(
        and(
          eq(auditLog.userId, manifest.scope.userId),
          eq(auditLog.entityType, 'financial_repair'),
          eq(auditLog.entityId, manifest.id),
          eq(auditLog.action, `financial_repair_${operation}`),
        ),
      );
    if (!rows.length) return null;
    if (rows.length !== 1) throw new Error('REPAIR_RECEIPT_CONFLICT');
    const receipt = receiptSchema.parse(rows[0].newData);
    if (
      receipt.manifestHash !== financialManifestHash(manifest) ||
      receipt.target !== manifest.target ||
      receipt.operation !== operation
    )
      throw new Error('REPAIR_RECEIPT_CONFLICT');
    return receipt;
  }

  private assertReceiptState(current: FinancialManifest, receipt: FinancialRepairReceipt) {
    for (const change of receipt.changes) {
      if (
        current.entries.find((e) => e.key === change.key)?.beforeHash !==
        financialManifestHash(change.after)
      )
        throw new Error('REPAIR_STATE_CHANGED');
    }
  }

  private async withRepairLocks<T>(
    manifest: FinancialManifest,
    callback: (db: DbExecutor) => Promise<T>,
  ): Promise<T> {
    return runWithMaterializationLock(this.db, manifest.scope.userId, async ({ db }) => {
      await db.execute(
        sql`SELECT set_config('app.current_user_id', ${manifest.scope.userId}, true)`,
      );
      await db.execute(sql`SET LOCAL lock_timeout = '10s'`);
      const selected = manifest.entries.filter((e) => e.decision === 'apply');
      const walletIds = selected.flatMap((e) => (e.before.wallet ? [e.before.wallet.id] : []));
      await db
        .select({ id: accounts.id })
        .from(accounts)
        .where(
          and(
            eq(accounts.userId, manifest.scope.userId),
            inArray(accounts.id, [...manifest.scope.cardAccountIds, ...walletIds]),
          ),
        )
        .orderBy(accounts.id)
        .for('update');
      await acquireBillLocks(
        db,
        manifest.scope.userId,
        selected.flatMap((e) =>
          e.before.bill
            ? [
                {
                  cardAccountId: e.before.bill.creditCardAccountId,
                  month: e.before.bill.month,
                  year: e.before.bill.year,
                },
              ]
            : [],
        ),
      );
      const from = periodNumber(manifest.scope.fromPeriod),
        to = periodNumber(manifest.scope.toPeriod);
      await db
        .select({ id: transactions.id })
        .from(transactions)
        .where(
          and(
            eq(transactions.userId, manifest.scope.userId),
            inArray(transactions.destinationAccountId, manifest.scope.cardAccountIds),
            sql`${transactions.billingYear} * 12 + ${transactions.billingMonth} BETWEEN ${from} AND ${to}`,
          ),
        )
        .orderBy(transactions.id)
        .for('update');
      await db
        .select({ id: creditCardBills.id })
        .from(creditCardBills)
        .where(
          and(
            inArray(creditCardBills.creditCardAccountId, manifest.scope.cardAccountIds),
            sql`${creditCardBills.year} * 12 + ${creditCardBills.month} BETWEEN ${from} AND ${to}`,
          ),
        )
        .orderBy(creditCardBills.id)
        .for('update');
      return callback(db);
    });
  }

  /** Caller supplies a repeatable-read, read-only transaction (see auditFinancialIntegrity). */
  async audit(input: RepairScope, targetInput: string): Promise<FinancialManifest> {
    const scope = repairScopeSchema.parse(input);
    const target = hashSchema.parse(targetInput);
    const asOf = new Date().toISOString();
    const owned = await this.db.select().from(accounts).where(eq(accounts.userId, scope.userId));
    const accountMap = new Map(owned.map((a) => [a.id, a]));
    if (scope.cardAccountIds.some((id) => accountMap.get(id)?.type !== 'credit_card'))
      throw new Error('REPAIR_ACCOUNT_SCOPE_INVALID');
    const from = periodNumber(scope.fromPeriod),
      to = periodNumber(scope.toPeriod);
    const rows = await this.db
      .select()
      .from(transactions)
      .where(
        and(
          eq(transactions.userId, scope.userId),
          inArray(transactions.destinationAccountId, scope.cardAccountIds),
          sql`${transactions.billingYear} * 12 + ${transactions.billingMonth} BETWEEN ${from} AND ${to}`,
        ),
      )
      .orderBy(transactions.id);
    const bills = await this.db
      .select()
      .from(creditCardBills)
      .where(
        and(
          inArray(creditCardBills.creditCardAccountId, scope.cardAccountIds),
          sql`${creditCardBills.year} * 12 + ${creditCardBills.month} BETWEEN ${from} AND ${to}`,
        ),
      )
      .orderBy(creditCardBills.id);
    const keys = new Set([
      ...rows.map(
        (r) => `${r.destinationAccountId}:${periodKey(r.billingYear ?? 0, r.billingMonth ?? 0)}`,
      ),
      ...bills.map((b) => `${b.creditCardAccountId}:${periodKey(b.year, b.month)}`),
    ]);
    const entries: RepairEntry[] = [];
    for (const key of [...keys].sort()) {
      const [cardId, period] = key.split(':');
      const card = accountMap.get(cardId);
      if (!card) throw new Error('REPAIR_ACCOUNT_SCOPE_INVALID');
      const items = rows.filter(
        (r) =>
          r.destinationAccountId === cardId &&
          periodKey(r.billingYear ?? 0, r.billingMonth ?? 0) === period,
      );
      const payments = items.filter((t) => t.domainType === 'bill_payment');
      const payment = payments.find((t) => !t.isReversed) ?? payments[0];
      const wallet = payment ? accountMap.get(payment.sourceAccountId) : undefined;
      const bill = bills.find(
        (b) => b.creditCardAccountId === cardId && periodKey(b.year, b.month) === period,
      );
      const before: RepairSnapshot = {
        card: accountState(card),
        wallet: wallet
          ? {
              ...accountState(wallet),
              openingBalance: wallet.openingBalance,
              cashAnchorBasis: wallet.cashAnchorBasis,
              openingBalanceAnchorAt: wallet.openingBalanceAnchorAt?.toISOString() ?? null,
            }
          : null,
        bill: bill ? billState(bill) : null,
        payments: payments.map(transactionState),
        charges: items.filter((t) => t.domainType !== 'bill_payment').map(transactionState),
      };
      const reasons = classify(before, asOf);
      const recordedAt = bill?.paidAt;
      const eligible = reasons.length === 0 && payment && wallet && recordedAt;
      entries.push({
        key,
        transactionId: payment?.id ?? null,
        before,
        beforeHash: financialManifestHash(before),
        decision: eligible ? 'pending' : 'exclude',
        reasons: eligible ? ['bank-evidence-required'] : reasons,
        evidence: null,
        proposal: eligible
          ? { isPaid: true, paidAt: recordedAt.toISOString(), paidFromAccountId: wallet.id }
          : null,
        expectedDelta: eligible
          ? {
              walletAccountId: wallet.id,
              period: payment.date.toISOString().slice(0, 7),
              amount: Money.zero('BRL')
                .subtract(Money.fromString(payment.amount, 'BRL'))
                .toDbString(),
            }
          : null,
      });
    }
    return financialManifestSchema.parse({
      version: 2,
      id: randomUUID(),
      target,
      createdAt: asOf,
      asOf,
      scope,
      anchorPolicy: 'preserve',
      cashReconciled: false,
      status: 'draft',
      review: null,
      entries,
      expectedDeltaByWalletPeriod: [],
    });
  }
}

export function createFinancialRepairInverse(input: unknown): FinancialRepairInverse {
  const receipt = receiptSchema.parse(input);
  if (receipt.operation !== 'apply') throw new Error('REPAIR_APPLY_RECEIPT_REQUIRED');
  return inverseSchema.parse({
    version: 2,
    manifestId: receipt.manifestId,
    manifestHash: receipt.manifestHash,
    receiptHash: financialManifestHash(receipt),
    target: receipt.target,
    scope: receipt.scope,
    status: 'draft',
    review: null,
    operations: receipt.changes.map((change) => {
      const previous = change.before.payments.find((p) => p.id === change.transactionId);
      if (!previous) throw new Error('REPAIR_RECEIPT_INVALID');
      return {
        transactionId: change.transactionId,
        expectedAfterHash: financialManifestHash(change.after),
        restore: {
          isPaid: previous.isPaid,
          paidAt: previous.paidAt,
          cashAmount: previous.cashAmount,
          settlementSource: previous.settlementSource,
          settlementDate: previous.settlementDate,
          paidFromAccountId: previous.paidFromAccountId,
        },
      };
    }),
  });
}

export function reviewFinancialRepairInverse(
  input: unknown,
  operator: string,
): FinancialRepairInverse {
  const inverse = inverseSchema.parse(input);
  if (inverse.status !== 'draft') throw new Error('REPAIR_DRAFT_REQUIRED');
  return inverseSchema.parse({
    ...inverse,
    status: 'reviewed',
    review: { by: operator, at: new Date().toISOString() },
  });
}

export async function auditFinancialIntegrity(
  db: Database,
  scope: RepairScope,
  target: string,
): Promise<FinancialManifest> {
  return db.transaction(
    async (tx) => {
      await tx.execute(sql`SELECT set_config('app.current_user_id', ${scope.userId}, true)`);
      return new FinancialRepairService(tx).audit(scope, target);
    },
    { isolationLevel: 'repeatable read', accessMode: 'read only' },
  );
}
