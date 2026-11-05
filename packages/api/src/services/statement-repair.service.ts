import { randomUUID } from 'node:crypto';
import type { Database, DbExecutor } from '@fc/db';
import {
  accounts,
  auditLog,
  borrowedCards,
  creditCardBills,
  creditCardConfigs,
  faturaImports,
  faturaMatchRules,
  monthClosings,
  scheduledTransactions,
  transactions,
} from '@fc/db';
import { Money, resolveStatementCycle } from '@fc/domain';
import { and, eq, inArray, or, sql } from 'drizzle-orm';
import { z } from 'zod';
import { acquireBillLocks } from '../lib/bill-lock.ts';
import { runWithMaterializationLock } from '../lib/materialization-lock.ts';
import { AuditService } from './audit.service.ts';
import {
  financialManifestHash,
  type RepairSafety,
  type RepairScope,
  repairScopeSchema,
  validateRepairBackup,
} from './financial-repair.service.ts';
import { WalletCashService } from './wallet-cash.service.ts';

const hash = z.string().regex(/^[a-f0-9]{64}$/);
const day = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .refine((v) => !Number.isNaN(Date.parse(v)) && new Date(v).toISOString().slice(0, 10) === v);
const period = z.string().regex(/^20\d{2}-(0[1-9]|1[0-2])$/);
const review = z
  .object({ by: z.string().trim().min(1).max(200), at: z.string().datetime() })
  .strict();
const evidenceSchema = z
  .object({
    importId: z.guid(),
    statementSha256: hash,
    entryReference: z.string().trim().min(1).max(200),
    closingDate: day,
    dueDate: day,
    chargeIds: z.array(z.guid()).min(1),
  })
  .strict();
const groupSchema = z
  .object({
    key: z.string(),
    cardAccountId: z.guid(),
    period,
    billId: z.guid().nullable(),
    importIds: z.array(z.guid()),
    chargeIds: z.array(z.guid()),
    paymentIds: z.array(z.guid()),
    scheduleIds: z.array(z.guid()),
    ruleIds: z.array(z.guid()),
    schedules: z.array(
      z
        .object({
          id: z.guid(),
          startingOccurrence: z.number(),
          firstBillingMonth: z.number().nullable(),
          firstBillingYear: z.number().nullable(),
          startDate: day,
          remainingRows: z.number(),
        })
        .strict(),
    ),
    proposedPeriod: period.nullable(),
    proposalConfidence: z.enum(['confirmed', 'estimated', 'unknown']),
    compositionTotal: z.string(),
    compositionDelta: z.string().nullable(),
    dueDate: day.nullable(),
    closingDate: day.nullable(),
    documentHash: hash.nullable(),
    confirmedClosingDate: day.nullable(),
    confirmedDueDate: day.nullable(),
    reasons: z.array(z.string()),
  })
  .strict();
export const statementManifestSchema = z
  .object({
    version: z.literal(1),
    kind: z.literal('statement-cycles'),
    id: z.guid(),
    target: hash,
    createdAt: z.string().datetime(),
    asOf: z.string().datetime(),
    scope: repairScopeSchema,
    stateHash: hash,
    status: z.enum(['draft', 'reviewed']),
    review: review.nullable(),
    groups: z.array(groupSchema),
    closedPeriods: z.array(period),
    evidence: z.array(evidenceSchema),
  })
  .strict();
export type StatementManifest = z.infer<typeof statementManifestSchema>;
type Group = z.infer<typeof groupSchema>;

const source = z.enum(['unknown', 'institution', 'user', 'configuration']);
const billFields = z
  .object({
    month: z.number().int(),
    year: z.number().int(),
    closingDate: day.nullable(),
    dueDate: day.nullable(),
    closingDateSource: source,
    dueDateSource: source,
  })
  .strict();
const importFields = z
  .object({
    billingMonth: z.number().int(),
    billingYear: z.number().int(),
    closingDate: day.nullable(),
    dueDate: day,
    closingDateSource: source,
    dueDateSource: source,
    periodConfidence: z.enum(['unknown', 'estimated', 'confirmed']),
  })
  .strict();
const transactionFields = z
  .object({ billingMonth: z.number().int().nullable(), billingYear: z.number().int().nullable() })
  .strict();
const patchSchema = z.discriminatedUnion('entity', [
  z
    .object({
      entity: z.literal('bill'),
      id: z.guid(),
      before: billFields,
      after: billFields,
    })
    .strict(),
  z
    .object({
      entity: z.literal('import'),
      id: z.guid(),
      before: importFields,
      after: importFields,
    })
    .strict(),
  z
    .object({
      entity: z.literal('transaction'),
      id: z.guid(),
      before: transactionFields,
      after: transactionFields,
    })
    .strict(),
]);
const receiptSchema = z
  .object({
    kind: z.literal('statement-cycles'),
    manifestId: z.guid(),
    manifestHash: hash,
    target: hash,
    scope: repairScopeSchema,
    operation: z.enum(['apply', 'revert']),
    createdAt: z.string().datetime(),
    backupSha256: hash,
    beforeHash: hash,
    afterHash: hash,
    evidence: z.array(evidenceSchema),
    review,
    patches: z.array(patchSchema),
    mapping: z.array(
      z
        .object({
          cardAccountId: z.guid(),
          from: period,
          to: period,
          importId: z.guid(),
        })
        .strict(),
    ),
    invariantsBefore: z.record(z.string(), z.unknown()),
    invariantsAfter: z.record(z.string(), z.unknown()),
  })
  .strict();
type Receipt = z.infer<typeof receiptSchema>;
const inverseSchema = z
  .object({
    kind: z.literal('statement-cycles'),
    manifestId: z.guid(),
    receiptHash: hash,
    status: z.enum(['draft', 'reviewed']),
    review: review.nullable(),
  })
  .strict();
const key = (year: number, month: number) => `${year}-${String(month).padStart(2, '0')}`;
const inScope = (value: string, scope: RepairScope) =>
  value >= scope.fromPeriod && value <= scope.toPeriod;

function proposal(manifest: StatementManifest, evidence: z.infer<typeof evidenceSchema>) {
  const group = manifest.groups.find((g) => g.importIds.includes(evidence.importId));
  if (
    !group ||
    group.importIds.length !== 1 ||
    !group.billId ||
    group.compositionDelta !== '0.00' ||
    group.reasons.some((r) =>
      [
        'closed-snapshot',
        'bill-composition-difference',
        'related-card',
        'mixed-currencies',
        'reversed-history',
        'document-difference',
        'multiple-imports',
        'consolidated-import',
      ].includes(r),
    )
  )
    throw new Error('REPAIR_CYCLE_NOT_ELIGIBLE');
  if (
    financialManifestHash([...evidence.chargeIds].sort()) !==
      financialManifestHash([...group.chargeIds].sort()) ||
    new Set(evidence.chargeIds).size !== evidence.chargeIds.length ||
    (group.documentHash && group.documentHash !== evidence.statementSha256) ||
    evidence.dueDate !== group.dueDate
  )
    throw new Error('REPAIR_EVIDENCE_MISMATCH');
  if (
    (group.confirmedClosingDate && group.confirmedClosingDate !== evidence.closingDate) ||
    (group.confirmedDueDate && group.confirmedDueDate !== evidence.dueDate)
  )
    throw new Error('REPAIR_CONFIRMED_DATE_CONFLICT');
  const cycle = resolveStatementCycle({
    reference: 'closing',
    month: Number(evidence.closingDate.slice(5, 7)),
    year: Number(evidence.closingDate.slice(0, 4)),
    closingDate: evidence.closingDate,
    dueDate: evidence.dueDate,
  });
  const to = key(cycle.billingYear, cycle.billingMonth);
  if (!inScope(to, manifest.scope) || manifest.closedPeriods.includes(to))
    throw new Error('REPAIR_SCOPE_OR_CLOSED_PERIOD');
  if (to !== group.period) {
    if (manifest.groups.some((g) => g.cardAccountId === group.cardAccountId && g.period === to))
      throw new Error('REPAIR_CYCLE_COLLISION');
    if (
      group.scheduleIds.length ||
      group.reasons.includes('related-card') ||
      group.reasons.includes('borrowed-card')
    )
      throw new Error('REPAIR_SERIES_OR_FAMILY_REVIEW_REQUIRED');
  }
  return { group, cycle, to };
}

export function reviewStatementManifest(
  input: unknown,
  evidenceInput: unknown,
  operator: string,
): StatementManifest {
  const manifest = statementManifestSchema.parse(input);
  if (manifest.status !== 'draft') throw new Error('REPAIR_DRAFT_REQUIRED');
  const evidence = z.array(evidenceSchema).min(1).parse(evidenceInput);
  const sources = new Set<string>(),
    targets = new Set<string>(),
    documents = new Set<string>();
  for (const item of evidence) {
    const { group, to } = proposal(manifest, item);
    const destination = `${group.cardAccountId}:${to}`;
    const document = `${item.statementSha256}:${item.entryReference}`;
    if (sources.has(group.key) || targets.has(destination) || documents.has(document))
      throw new Error('REPAIR_DUPLICATE_OPERATION');
    sources.add(group.key);
    targets.add(destination);
    documents.add(document);
  }
  return statementManifestSchema.parse({
    ...manifest,
    evidence,
    status: 'reviewed',
    review: { by: operator, at: new Date().toISOString() },
  });
}

export function validateStatementRepairRequest(
  input: unknown,
  safety: Omit<RepairSafety, 'backup'>,
) {
  const manifest = statementManifestSchema.parse(input);
  if (financialManifestHash(manifest) !== safety.expectedManifestHash)
    throw new Error('REPAIR_MANIFEST_HASH_MISMATCH');
  if (manifest.target !== safety.targetFingerprint || safety.confirmTarget !== manifest.target)
    throw new Error('REPAIR_TARGET_MISMATCH');
  if (manifest.status !== 'reviewed' || !manifest.review || !manifest.evidence.length)
    throw new Error('REPAIR_REVIEW_REQUIRED');
  if (
    safety.userId !== manifest.scope.userId ||
    safety.fromPeriod !== manifest.scope.fromPeriod ||
    safety.toPeriod !== manifest.scope.toPeriod
  )
    throw new Error('REPAIR_SCOPE_MISMATCH');
  if (!safety.producersPaused) throw new Error('REPAIR_PRODUCERS_MUST_BE_PAUSED');
  reviewStatementManifest(
    { ...manifest, status: 'draft', review: null },
    manifest.evidence,
    manifest.review.by,
  );
  return manifest;
}

export class StatementRepairService {
  constructor(private readonly db: DbExecutor) {}

  private async state(scope: RepairScope) {
    const owned = await this.db
      .select()
      .from(accounts)
      .where(eq(accounts.userId, scope.userId))
      .orderBy(accounts.id);
    if (
      scope.cardAccountIds.some((id) => !owned.some((a) => a.id === id && a.type === 'credit_card'))
    )
      throw new Error('REPAIR_ACCOUNT_SCOPE_INVALID');
    const rows = await this.db
      .select()
      .from(transactions)
      .where(
        and(
          eq(transactions.userId, scope.userId),
          or(
            inArray(transactions.destinationAccountId, scope.cardAccountIds),
            inArray(transactions.sourceAccountId, scope.cardAccountIds),
          ),
        ),
      )
      .orderBy(transactions.id);
    const bills = await this.db
      .select()
      .from(creditCardBills)
      .where(inArray(creditCardBills.creditCardAccountId, scope.cardAccountIds))
      .orderBy(creditCardBills.id);
    const imports = await this.db
      .select()
      .from(faturaImports)
      .where(
        and(
          eq(faturaImports.userId, scope.userId),
          inArray(faturaImports.cardAccountId, scope.cardAccountIds),
        ),
      )
      .orderBy(faturaImports.id);
    const schedules = await this.db
      .select()
      .from(scheduledTransactions)
      .where(
        and(
          eq(scheduledTransactions.userId, scope.userId),
          or(
            inArray(scheduledTransactions.destinationAccountId, scope.cardAccountIds),
            inArray(scheduledTransactions.sourceAccountId, scope.cardAccountIds),
          ),
        ),
      )
      .orderBy(scheduledTransactions.id);
    const rules = await this.db
      .select()
      .from(faturaMatchRules)
      .where(
        and(
          eq(faturaMatchRules.userId, scope.userId),
          inArray(faturaMatchRules.cardAccountId, scope.cardAccountIds),
        ),
      )
      .orderBy(faturaMatchRules.id);
    const borrowed = await this.db
      .select()
      .from(borrowedCards)
      .where(inArray(borrowedCards.creditCardAccountId, scope.cardAccountIds))
      .orderBy(borrowedCards.id);
    const months = await this.db
      .select()
      .from(monthClosings)
      .where(eq(monthClosings.userId, scope.userId))
      .orderBy(monthClosings.id);
    const configs = await this.db
      .select()
      .from(creditCardConfigs)
      .where(inArray(creditCardConfigs.accountId, scope.cardAccountIds))
      .orderBy(creditCardConfigs.id);
    return { owned, rows, bills, imports, schedules, rules, borrowed, months, configs };
  }

  async audit(input: RepairScope, target: string): Promise<StatementManifest> {
    const scope = repairScopeSchema.parse(input),
      state = await this.state(scope);
    const keys = new Set<string>();
    for (const row of state.rows)
      if (row.billingMonth && row.billingYear)
        keys.add(`${row.destinationAccountId}:${key(row.billingYear, row.billingMonth)}`);
    for (const bill of state.bills)
      keys.add(`${bill.creditCardAccountId}:${key(bill.year, bill.month)}`);
    for (const imported of state.imports)
      keys.add(`${imported.cardAccountId}:${key(imported.billingYear, imported.billingMonth)}`);
    const closedPeriods = state.months
      .filter((m) => m.status === 'closed')
      .map((m) => key(m.year, m.month));
    const groups: Group[] = [];
    for (const groupKey of [...keys].sort()) {
      const [cardAccountId, groupPeriod] = groupKey.split(':');
      if (!inScope(groupPeriod, scope) || !scope.cardAccountIds.includes(cardAccountId)) continue;
      const rows = state.rows.filter(
        (r) =>
          r.destinationAccountId === cardAccountId &&
          key(r.billingYear ?? 0, r.billingMonth ?? 0) === groupPeriod,
      );
      const charges = rows.filter((r) => r.domainType !== 'bill_payment');
      const payments = rows.filter((r) => r.domainType === 'bill_payment');
      const imports = state.imports.filter(
        (i) =>
          i.cardAccountId === cardAccountId &&
          key(i.billingYear, i.billingMonth) === groupPeriod &&
          i.status === 'applied',
      );
      const imported = imports.length === 1 ? imports[0] : undefined;
      const bill = state.bills.find(
        (b) => b.creditCardAccountId === cardAccountId && key(b.year, b.month) === groupPeriod,
      );
      const schedules = state.schedules.filter((s) =>
        charges.some((c) => c.scheduledTransactionId === s.id),
      );
      const mixed = charges.some((c) => c.currency !== 'BRL');
      const total = charges
        .filter((c) => !c.isReversed)
        .reduce(
          (sum, c) =>
            c.domainType === 'credit_card_refund'
              ? sum.subtract(Money.fromString(c.amount, 'BRL'))
              : sum.add(Money.fromString(c.amount, 'BRL')),
          Money.zero('BRL'),
        );
      const reasons: string[] = [];
      if (!bill) reasons.push('missing-bill');
      if (imports.length !== 1)
        reasons.push(imports.length ? 'multiple-imports' : 'missing-applied-import');
      if (!imported?.closingDate) reasons.push('closing-date-evidence-required');
      if (imported?.itemsJson.cardAccounts.some((c) => c.id !== cardAccountId))
        reasons.push('consolidated-import');
      if (imported?.itemsJson.totals.delta !== '0.00') reasons.push('document-difference');
      if (mixed) reasons.push('mixed-currencies');
      if (bill && !mixed && bill.totalAmount !== total.toDbString())
        reasons.push('bill-composition-difference');
      if (rows.some((r) => r.isReversed || r.reversesTransactionId || r.reversedByTransactionId))
        reasons.push('reversed-history');
      if (closedPeriods.includes(groupPeriod)) reasons.push('closed-snapshot');
      if (schedules.some((s) => s.startingOccurrence !== 1))
        reasons.push('starting-occurrence-needs-review');
      if (
        imported?.appliedAt &&
        rows.some((r) => r.updatedAt.getTime() > (imported.appliedAt?.getTime() ?? Infinity))
      )
        reasons.push('changes-after-import');
      if (
        state.owned.some((a) => a.id === cardAccountId && a.parentAccountId !== null) ||
        state.owned.some((a) => a.parentAccountId === cardAccountId)
      )
        reasons.push('related-card');
      if (state.borrowed.some((b) => b.creditCardAccountId === cardAccountId))
        reasons.push('borrowed-card');
      const compositionDelta =
        imported?.statedTotal != null && !mixed
          ? total.subtract(Money.fromString(imported.statedTotal, 'BRL')).toDbString()
          : null;
      if (compositionDelta !== '0.00') reasons.push('composition-difference');
      let proposedPeriod: string | null = null;
      let proposalConfidence: 'confirmed' | 'estimated' | 'unknown' = 'unknown';
      if (imported) {
        try {
          const card = state.owned.find((a) => a.id === cardAccountId);
          const config = state.configs.find(
            (c) => c.accountId === (card?.parentAccountId ?? cardAccountId),
          );
          const proposed = resolveStatementCycle({
            reference: 'due',
            month: Number(imported.dueDate.slice(5, 7)),
            year: Number(imported.dueDate.slice(0, 4)),
            closingDate: imported.closingDate,
            dueDate: imported.dueDate,
            config,
          });
          proposedPeriod = key(proposed.billingYear, proposed.billingMonth);
          proposalConfidence = proposed.confidence;
        } catch {
          reasons.push('ambiguous-cycle');
        }
      }
      groups.push({
        key: groupKey,
        cardAccountId,
        period: groupPeriod,
        billId: bill?.id ?? null,
        importIds: imports.map((i) => i.id),
        chargeIds: charges.map((c) => c.id),
        paymentIds: payments.map((p) => p.id),
        scheduleIds: schedules.map((s) => s.id),
        ruleIds: state.rules.filter((r) => r.cardAccountId === cardAccountId).map((r) => r.id),
        schedules: schedules.map((s) => ({
          id: s.id,
          startingOccurrence: s.startingOccurrence,
          firstBillingMonth: s.firstBillingMonth,
          firstBillingYear: s.firstBillingYear,
          startDate: s.startDate.toISOString().slice(0, 10),
          remainingRows: state.rows.filter((r) => r.scheduledTransactionId === s.id && !r.isPaid)
            .length,
        })),
        proposedPeriod,
        proposalConfidence,
        compositionTotal: total.toDbString(),
        compositionDelta,
        dueDate: imported?.dueDate ?? null,
        closingDate: imported?.closingDate ?? null,
        documentHash: imported?.documentHash ?? null,
        confirmedClosingDate:
          bill?.closingDateSource === 'institution' || bill?.closingDateSource === 'user'
            ? bill.closingDate
            : null,
        confirmedDueDate:
          bill?.dueDateSource === 'institution' || bill?.dueDateSource === 'user'
            ? bill.dueDate
            : null,
        reasons,
      });
    }
    const now = new Date().toISOString();
    return statementManifestSchema.parse({
      version: 1,
      kind: 'statement-cycles',
      id: randomUUID(),
      target,
      createdAt: now,
      asOf: now,
      scope,
      stateHash: financialManifestHash(state),
      status: 'draft',
      review: null,
      groups,
      closedPeriods,
      evidence: [],
    });
  }

  private async invariants(scope: RepairScope, asOf: string) {
    const state = await this.state(scope);
    const totals: Record<string, string> = {};
    for (const row of state.rows) {
      const currency = row.currency;
      totals[currency] = Money.fromString(totals[currency] ?? '0', currency)
        .add(Money.fromString(row.amount, currency))
        .toDbString();
    }
    return {
      count: state.rows.length,
      totals,
      rows: financialManifestHash(
        state.rows.map(({ billingMonth: _m, billingYear: _y, updatedAt: _u, ...row }) => row),
      ),
      schedules: financialManifestHash(state.schedules),
      rules: financialManifestHash(state.rules),
      months: financialManifestHash(state.months),
      borrowed: financialManifestHash(state.borrowed),
      wallets: (
        await new WalletCashService(this.db).getWalletCash(scope.userId, new Date(asOf))
      ).wallets
        .map((w) => ({ id: w.id, cash: w.cash }))
        .sort((a, b) => a.id.localeCompare(b.id)),
    };
  }

  private async withLocks<T>(
    manifest: StatementManifest,
    callback: (service: StatementRepairService) => Promise<T>,
  ) {
    return runWithMaterializationLock(this.db, manifest.scope.userId, async ({ db }) => {
      await db.execute(
        sql`SELECT set_config('app.current_user_id', ${manifest.scope.userId}, true)`,
      );
      await db.execute(sql`SET LOCAL lock_timeout='10s'`);
      await db
        .select({ id: accounts.id })
        .from(accounts)
        .where(eq(accounts.userId, manifest.scope.userId))
        .orderBy(accounts.id)
        .for('update');
      await acquireBillLocks(
        db,
        manifest.scope.userId,
        manifest.evidence.flatMap((e) => {
          const { group, cycle } = proposal(manifest, e);
          return [
            {
              cardAccountId: group.cardAccountId,
              month: Number(group.period.slice(5)),
              year: Number(group.period.slice(0, 4)),
            },
            {
              cardAccountId: group.cardAccountId,
              month: cycle.billingMonth,
              year: cycle.billingYear,
            },
          ];
        }),
      );
      await db
        .select({ id: transactions.id })
        .from(transactions)
        .where(eq(transactions.userId, manifest.scope.userId))
        .orderBy(transactions.id)
        .for('update');
      await db
        .select({ id: faturaImports.id })
        .from(faturaImports)
        .where(eq(faturaImports.userId, manifest.scope.userId))
        .orderBy(faturaImports.id)
        .for('update');
      await db
        .select({ id: creditCardBills.id })
        .from(creditCardBills)
        .where(inArray(creditCardBills.creditCardAccountId, manifest.scope.cardAccountIds))
        .orderBy(creditCardBills.id)
        .for('update');
      return callback(new StatementRepairService(db));
    });
  }

  private async receipt(manifest: StatementManifest, operation: 'apply' | 'revert') {
    const rows = await this.db
      .select()
      .from(auditLog)
      .where(
        and(
          eq(auditLog.userId, manifest.scope.userId),
          eq(auditLog.entityType, 'statement_repair'),
          eq(auditLog.entityId, manifest.id),
          eq(auditLog.action, `statement_repair_${operation}`),
        ),
      );
    if (!rows.length) return null;
    if (rows.length !== 1) throw new Error('REPAIR_RECEIPT_CONFLICT');
    const receipt = receiptSchema.parse(rows[0].newData);
    if (
      receipt.manifestHash !== financialManifestHash(manifest) ||
      receipt.target !== manifest.target
    )
      throw new Error('REPAIR_RECEIPT_CONFLICT');
    return receipt;
  }

  private async writePatch(patch: z.infer<typeof patchSchema>, userId: string, revert = false) {
    const updatedAt = new Date();
    if (patch.entity === 'bill')
      await this.db
        .update(creditCardBills)
        .set({ ...(revert ? patch.before : patch.after), updatedAt })
        .where(eq(creditCardBills.id, patch.id));
    else if (patch.entity === 'import')
      await this.db
        .update(faturaImports)
        .set({ ...(revert ? patch.before : patch.after), updatedAt })
        .where(and(eq(faturaImports.id, patch.id), eq(faturaImports.userId, userId)));
    else
      await this.db
        .update(transactions)
        .set({ ...(revert ? patch.before : patch.after), updatedAt })
        .where(and(eq(transactions.id, patch.id), eq(transactions.userId, userId)));
  }

  async apply(input: unknown, safety: RepairSafety) {
    const manifest = validateStatementRepairRequest(input, safety);
    await validateRepairBackup(manifest, safety.backup);
    return this.withLocks(manifest, async (service) => {
      if (await service.receipt(manifest, 'revert')) throw new Error('REPAIR_ALREADY_REVERTED');
      const prior = await service.receipt(manifest, 'apply');
      const state = await service.state(manifest.scope),
        stateHash = financialManifestHash(state);
      if (prior) {
        if (prior.afterHash !== stateHash) throw new Error('REPAIR_STATE_CHANGED');
        return { status: 'already-applied', receipt: prior };
      }
      if (stateHash !== manifest.stateHash) throw new Error('REPAIR_STATE_CHANGED');
      const current = await service.audit(manifest.scope, manifest.target);
      if (
        financialManifestHash(current.groups) !== financialManifestHash(manifest.groups) ||
        financialManifestHash(current.closedPeriods) !==
          financialManifestHash(manifest.closedPeriods)
      )
        throw new Error('REPAIR_STATE_CHANGED');
      const previousRepairs = await service.db
        .select()
        .from(auditLog)
        .where(
          and(
            eq(auditLog.userId, manifest.scope.userId),
            eq(auditLog.entityType, 'statement_repair'),
            eq(auditLog.action, 'statement_repair_apply'),
          ),
        );
      const usedEvidence = new Set(
        previousRepairs.flatMap((row) =>
          receiptSchema
            .parse(row.newData)
            .evidence.map((e) => `${e.statementSha256}:${e.entryReference}`),
        ),
      );
      if (
        manifest.evidence.some((e) => usedEvidence.has(`${e.statementSha256}:${e.entryReference}`))
      )
        throw new Error('REPAIR_EVIDENCE_REUSED');
      const patches: z.infer<typeof patchSchema>[] = [],
        mapping: Receipt['mapping'] = [];
      for (const e of manifest.evidence) {
        const { group, cycle, to } = proposal(current, e);
        const bill = state.bills.find((b) => b.id === group.billId),
          imported = state.imports.find((i) => i.id === e.importId);
        if (!bill || !imported) throw new Error('REPAIR_STATE_CHANGED');
        patches.push({
          entity: 'bill',
          id: bill.id,
          before: {
            month: bill.month,
            year: bill.year,
            closingDate: bill.closingDate,
            dueDate: bill.dueDate,
            closingDateSource: bill.closingDateSource,
            dueDateSource: bill.dueDateSource,
          },
          after: {
            month: cycle.billingMonth,
            year: cycle.billingYear,
            closingDate: e.closingDate,
            dueDate: e.dueDate,
            closingDateSource: 'institution',
            dueDateSource: 'institution',
          },
        });
        patches.push({
          entity: 'import',
          id: imported.id,
          before: {
            billingMonth: imported.billingMonth,
            billingYear: imported.billingYear,
            closingDate: imported.closingDate,
            dueDate: imported.dueDate,
            closingDateSource: imported.closingDateSource,
            dueDateSource: imported.dueDateSource,
            periodConfidence: imported.periodConfidence,
          },
          after: {
            billingMonth: cycle.billingMonth,
            billingYear: cycle.billingYear,
            closingDate: e.closingDate,
            dueDate: e.dueDate,
            closingDateSource: 'institution',
            dueDateSource: 'institution',
            periodConfidence: 'confirmed',
          },
        });
        if (to !== group.period)
          for (const id of [...group.chargeIds, ...group.paymentIds]) {
            const row = state.rows.find((r) => r.id === id);
            if (!row) throw new Error('REPAIR_STATE_CHANGED');
            patches.push({
              entity: 'transaction',
              id,
              before: { billingMonth: row.billingMonth, billingYear: row.billingYear },
              after: { billingMonth: cycle.billingMonth, billingYear: cycle.billingYear },
            });
          }
        mapping.push({
          cardAccountId: group.cardAccountId,
          from: group.period,
          to,
          importId: e.importId,
        });
      }
      const invariantsBefore = await service.invariants(manifest.scope, manifest.asOf);
      for (const patch of patches) await service.writePatch(patch, manifest.scope.userId);
      const invariantsAfter = await service.invariants(manifest.scope, manifest.asOf);
      if (financialManifestHash(invariantsBefore) !== financialManifestHash(invariantsAfter))
        throw new Error('REPAIR_INVARIANT_CHANGED');
      const receipt = receiptSchema.parse({
        kind: 'statement-cycles',
        manifestId: manifest.id,
        manifestHash: safety.expectedManifestHash,
        target: manifest.target,
        scope: manifest.scope,
        operation: 'apply',
        createdAt: new Date().toISOString(),
        backupSha256: safety.backup.sha256,
        beforeHash: stateHash,
        afterHash: financialManifestHash(await service.state(manifest.scope)),
        evidence: manifest.evidence,
        review: manifest.review,
        patches,
        mapping,
        invariantsBefore,
        invariantsAfter,
      });
      await new AuditService(service.db).log(
        manifest.scope.userId,
        'statement_repair_apply',
        'statement_repair',
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
  ) {
    const manifest = validateStatementRepairRequest(input, safety),
      inverse = inverseSchema.parse(inverseInput);
    if (
      inverse.status !== 'reviewed' ||
      !inverse.review ||
      inverse.manifestId !== manifest.id ||
      financialManifestHash(inverse) !== safety.expectedInverseHash
    )
      throw new Error('REPAIR_INVERSE_REVIEW_REQUIRED');
    await validateRepairBackup(manifest, safety.backup);
    return this.withLocks(manifest, async (service) => {
      const original = await service.receipt(manifest, 'apply');
      if (!original || financialManifestHash(original) !== inverse.receiptHash)
        throw new Error('REPAIR_INVERSE_MISMATCH');
      if (safety.backup.createdAt < original.createdAt)
        throw new Error('REPAIR_FRESH_BACKUP_REQUIRED');
      const prior = await service.receipt(manifest, 'revert'),
        stateHash = financialManifestHash(await service.state(manifest.scope));
      if (prior) {
        if (prior.afterHash !== stateHash) throw new Error('REPAIR_STATE_CHANGED');
        return { status: 'already-reverted', receipt: prior };
      }
      if (stateHash !== original.afterHash) throw new Error('REPAIR_STATE_CHANGED');
      const invariantsBefore = await service.invariants(manifest.scope, manifest.asOf);
      for (const patch of [...original.patches].reverse())
        await service.writePatch(patch, manifest.scope.userId, true);
      const invariantsAfter = await service.invariants(manifest.scope, manifest.asOf);
      if (financialManifestHash(invariantsBefore) !== financialManifestHash(invariantsAfter))
        throw new Error('REPAIR_INVARIANT_CHANGED');
      const receipt = receiptSchema.parse({
        ...original,
        operation: 'revert',
        createdAt: new Date().toISOString(),
        backupSha256: safety.backup.sha256,
        beforeHash: stateHash,
        afterHash: financialManifestHash(await service.state(manifest.scope)),
        invariantsBefore,
        invariantsAfter,
      });
      await new AuditService(service.db).log(
        manifest.scope.userId,
        'statement_repair_revert',
        'statement_repair',
        manifest.id,
        undefined,
        receipt,
      );
      return { status: 'reverted', receipt };
    });
  }
}

export function createStatementInverse(input: unknown) {
  const receipt = receiptSchema.parse(input);
  if (receipt.operation !== 'apply') throw new Error('REPAIR_APPLY_RECEIPT_REQUIRED');
  return inverseSchema.parse({
    kind: 'statement-cycles',
    manifestId: receipt.manifestId,
    receiptHash: financialManifestHash(receipt),
    status: 'draft',
    review: null,
  });
}
export function reviewStatementInverse(input: unknown, operator: string) {
  const inverse = inverseSchema.parse(input);
  if (inverse.status !== 'draft') throw new Error('REPAIR_DRAFT_REQUIRED');
  return inverseSchema.parse({
    ...inverse,
    status: 'reviewed',
    review: { by: operator, at: new Date().toISOString() },
  });
}
export async function auditStatementIntegrity(db: Database, scope: RepairScope, target: string) {
  return db.transaction(
    async (tx) => {
      await tx.execute(sql`SELECT set_config('app.current_user_id', ${scope.userId}, true)`);
      return new StatementRepairService(tx).audit(scope, target);
    },
    { isolationLevel: 'repeatable read', accessMode: 'read only' },
  );
}
