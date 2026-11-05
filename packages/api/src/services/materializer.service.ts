import { and, eq, inArray, isNull } from 'drizzle-orm';

// Monthly-family income is exactly one occurrence per calendar month, and the CLT
// business-day roll never crosses a month boundary — so a month bucket is a stable
// dedup identity. Used to suppress a rolled/recomputed occurrence that no longer
// matches a preserved PAID income row's exact date (which a date-only key misses).
const MONTHLY_FAMILY_FREQ = new Set(['monthly', 'bimonthly', 'quarterly', 'semiannual', 'annual']);
const MATERIALIZATION_BATCH_SIZE = 250;

// Converts a date (from DB as Date, or raw string) to a "YYYY-MM-DD" key.
// Using toISOString() ensures both occurrence dates (local midnight in UTC-)
// and DB dates (UTC midnight from mode: 'date') produce the same calendar-day string.
function dateToKey(d: Date | string): string {
  if (typeof d === 'string') {
    return d.slice(0, 10);
  }
  return d.toISOString().slice(0, 10);
}

// Drizzle `date(mode:'date')` columns deserialize as UTC-midnight Dates; reading
// them with LOCAL getters (as computeOccurrenceDates does) in a negative-offset
// TZ (e.g. America/Sao_Paulo) shifts the calendar day back — a day-1 start then
// reports the previous month/day and generates a phantom prior-month occurrence.
// Reconstruct a LOCAL-midnight Date for the SAME calendar day so getMonth()/
// getDate() agree with the stored day regardless of host timezone.
function toLocalCalendarDay(d: Date): Date {
  return new Date(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
}

// Stable content fingerprint used to recognise a manually-inserted reconciliation
// row (scheduled_transaction_id = NULL) as "covering" an equivalent schedule
// occurrence, so the materializer does not insert a duplicate beside it.
function contentKey(r: {
  sourceAccountId: string;
  destinationAccountId: string;
  amount: string;
  billingMonth: number | null;
  billingYear: number | null;
  installmentNumber: number | null;
  domainType: string | null;
}): string {
  return [
    r.sourceAccountId,
    r.destinationAccountId,
    Number(r.amount).toFixed(2),
    r.billingMonth ?? '',
    r.billingYear ?? '',
    r.installmentNumber ?? '',
    r.domainType ?? '',
  ].join('|');
}

import type { DbExecutor } from '@fc/db';
import {
  accounts,
  incomeSourceConfigs,
  monthClosings,
  scheduledTransactions,
  transactions,
} from '@fc/db';
import type { AccountType } from '@fc/domain';
import {
  assignOccurrenceBilling,
  computeOccurrenceDates,
  deriveTransactionType,
  getDomainTypesByGroup,
  InvariantViolationError,
  previousBusinessDay,
  resolveScheduledAmount,
} from '@fc/domain';

import { loadEffectiveCardConfigs } from '../lib/card-group.ts';
import { logger } from '../lib/logger.ts';
import {
  assertMaterializationLock,
  type MaterializationLock,
  runWithMaterializationLock,
} from '../lib/materialization-lock.ts';
import { openCardPeriod } from '../lib/open-card-period.ts';
import { measureOperation, type OperationTelemetryContext } from '../lib/operation-timer.ts';
import { AccountService } from './account.service.ts';

type InvalidSchedule = { scheduleId: string; startingOccurrence: number };
type OccurrenceDates = Pick<
  typeof transactions.$inferSelect,
  'purchaseDate' | 'purchaseDateSource' | 'postedDate' | 'postedDateSource'
> & {
  classification?: Pick<
    typeof transactions.$inferSelect,
    | 'id'
    | 'createdAt'
    | 'categoryId'
    | 'classificationSource'
    | 'classificationRuleId'
    | 'classificationRuleVersion'
    | 'classificationConfidence'
    | 'classificationReviewedAt'
    | 'economicResponsibility'
    | 'receivableAccountId'
  >;
};

function occurrenceIdentity(
  scheduleId: string,
  date: string,
  installment: number | null,
  month: number | null,
  year: number | null,
  monthly: boolean,
) {
  return `${scheduleId}|${installment !== null ? `installment:${installment}` : month && year ? `billing:${year}-${month}` : monthly ? `month:${date.slice(0, 7)}` : date}`;
}

export type MaterializationScope = { kind: 'full' } | { kind: 'targeted'; scheduleIds: string[] };

export type MaterializeResult = {
  created: number;
  skipped: number;
  invalidSchedules: InvalidSchedule[];
  scope: 'full' | 'targeted';
  schedulesLoaded: number;
  existingRowsLoaded: number;
  manualRowsLoaded: number;
  candidateOccurrences: number;
  closedPeriodSkipped: number;
  inactiveAccountSkipped: number;
};

export type MaterializeScheduleChangesInput = {
  scope: 'targeted' | 'full-fill' | 'full-rebuild';
  fillScheduleIds: string[];
  rebuildScheduleIds: string[];
  horizonMonths: number;
  telemetry?: OperationTelemetryContext;
};

export class MaterializerService {
  // 120 months (10 years) covers long consignado loans (up to 96 months on INSS)
  // and multi-year credit card installments, while still rejecting DoS-style
  // horizons like 1000+.
  static readonly MAX_HORIZON_MONTHS = 120;

  private accountService: AccountService;

  constructor(
    private db: DbExecutor,
    private readonly telemetry?: OperationTelemetryContext,
  ) {
    this.accountService = new AccountService(db);
  }

  async materialize(userId: string, horizonMonths: number = 12): Promise<MaterializeResult> {
    return this.materializeScope(userId, horizonMonths, { kind: 'full' });
  }

  async materializeSchedules(
    userId: string,
    scheduleIds: string[],
    horizonMonths: number = 12,
  ): Promise<MaterializeResult> {
    const uniqueIds = [...new Set(scheduleIds)];
    if (uniqueIds.length === 0) {
      return this.emptyResult('targeted');
    }
    return this.materializeScope(userId, horizonMonths, {
      kind: 'targeted',
      scheduleIds: uniqueIds,
    });
  }

  async materializeScheduleChanges(
    userId: string,
    input: MaterializeScheduleChangesInput,
  ): Promise<MaterializeResult> {
    this.assertHorizon(input.horizonMonths);
    const rebuildScheduleIds = [...new Set(input.rebuildScheduleIds)];
    const rebuildSet = new Set(rebuildScheduleIds);
    const fillScheduleIds = [...new Set(input.fillScheduleIds)].filter((id) => !rebuildSet.has(id));

    return runWithMaterializationLock(this.db, userId, async ({ db, lock }) => {
      const inner = new MaterializerService(db, input.telemetry ?? this.telemetry);
      let selectedIds = [...new Set([...fillScheduleIds, ...rebuildScheduleIds])];
      if (input.scope !== 'targeted') {
        const schedules = await db
          .select({ id: scheduledTransactions.id })
          .from(scheduledTransactions)
          .where(
            and(eq(scheduledTransactions.userId, userId), eq(scheduledTransactions.isActive, true)),
          );
        selectedIds = schedules.map((schedule) => schedule.id);
      }

      const effectiveRebuildIds = input.scope === 'full-rebuild' ? selectedIds : rebuildScheduleIds;
      const preservedDates = new Map<string, OccurrenceDates>();
      if (effectiveRebuildIds.length > 0) {
        const frequencies = new Map(
          (
            await db
              .select({ id: scheduledTransactions.id, frequency: scheduledTransactions.frequency })
              .from(scheduledTransactions)
              .where(
                and(
                  eq(scheduledTransactions.userId, userId),
                  inArray(scheduledTransactions.id, effectiveRebuildIds),
                ),
              )
          ).map((r) => [r.id, r.frequency]),
        );
        const removed = await db
          .delete(transactions)
          .where(
            and(
              eq(transactions.userId, userId),
              inArray(transactions.scheduledTransactionId, effectiveRebuildIds),
              eq(transactions.isReversed, false),
              eq(transactions.isPaid, false),
              eq(transactions.isAmountOverridden, false),
              openCardPeriod(),
            ),
          )
          .returning();
        for (const row of removed) {
          if (
            row.purchaseDate !== null ||
            row.postedDate !== null ||
            row.classificationReviewedAt
          ) {
            const preserved: OccurrenceDates = {
              ...row,
              ...(row.classificationReviewedAt
                ? {
                    classification: {
                      id: row.id,
                      createdAt: row.createdAt,
                      categoryId: row.categoryId,
                      classificationSource: row.classificationSource,
                      classificationRuleId: row.classificationRuleId,
                      classificationRuleVersion: row.classificationRuleVersion,
                      classificationConfidence: row.classificationConfidence,
                      classificationReviewedAt: row.classificationReviewedAt,
                      economicResponsibility: row.economicResponsibility,
                      receivableAccountId: row.receivableAccountId,
                    },
                  }
                : {}),
            };
            preservedDates.set(`${row.scheduledTransactionId}|${dateToKey(row.date)}`, preserved);
            if (row.classificationReviewedAt && row.scheduledTransactionId)
              preservedDates.set(
                occurrenceIdentity(
                  row.scheduledTransactionId,
                  dateToKey(row.date),
                  row.installmentNumber,
                  row.billingMonth,
                  row.billingYear,
                  MONTHLY_FAMILY_FREQ.has(frequencies.get(row.scheduledTransactionId) ?? ''),
                ),
                preserved,
              );
          }
        }
      }

      if (selectedIds.length === 0) {
        return inner.emptyResult(input.scope === 'targeted' ? 'targeted' : 'full');
      }
      return inner.materializeCore(
        userId,
        input.horizonMonths,
        input.scope === 'targeted'
          ? { kind: 'targeted', scheduleIds: selectedIds }
          : { kind: 'full' },
        lock,
        preservedDates,
      );
    });
  }

  private async materializeScope(
    userId: string,
    horizonMonths: number,
    scope: MaterializationScope,
  ): Promise<MaterializeResult> {
    this.assertHorizon(horizonMonths);
    return runWithMaterializationLock(this.db, userId, async ({ db, lock }) => {
      const inner = new MaterializerService(db, this.telemetry);
      return inner.materializeCore(userId, horizonMonths, scope, lock);
    });
  }

  private assertHorizon(horizonMonths: number): void {
    if (
      !Number.isInteger(horizonMonths) ||
      horizonMonths < 1 ||
      horizonMonths > MaterializerService.MAX_HORIZON_MONTHS
    ) {
      throw new InvariantViolationError(
        `horizonMonths=${horizonMonths} is out of range [1, ${MaterializerService.MAX_HORIZON_MONTHS}]`,
        { horizonMonths, max: MaterializerService.MAX_HORIZON_MONTHS },
      );
    }
  }

  private emptyResult(scope: MaterializeResult['scope']): MaterializeResult {
    return {
      created: 0,
      skipped: 0,
      invalidSchedules: [],
      scope,
      schedulesLoaded: 0,
      existingRowsLoaded: 0,
      manualRowsLoaded: 0,
      candidateOccurrences: 0,
      closedPeriodSkipped: 0,
      inactiveAccountSkipped: 0,
    };
  }

  private async materializeCore(
    userId: string,
    horizonMonths: number,
    scope: MaterializationScope,
    lock: MaterializationLock,
    preservedDates: ReadonlyMap<string, OccurrenceDates> = new Map(),
  ): Promise<MaterializeResult> {
    assertMaterializationLock(lock, userId);
    const materializeScope = scope.kind === 'full' ? 'full' : 'targeted';
    return measureOperation(
      'credit_card.materialize',
      { scope: materializeScope, repairMode: 'fill' },
      async () => this.materializeCoreUnsafe(userId, horizonMonths, scope, preservedDates),
      this.telemetry,
    );
  }

  private async materializeCoreUnsafe(
    userId: string,
    horizonMonths: number,
    scope: MaterializationScope,
    preservedDates: ReadonlyMap<string, OccurrenceDates>,
  ): Promise<MaterializeResult> {
    const targetedIds = scope.kind === 'targeted' ? scope.scheduleIds : null;
    // Load all active schedules for the user, or exactly the selected active schedules.
    const schedules = await this.db
      .select()
      .from(scheduledTransactions)
      .where(
        and(
          eq(scheduledTransactions.userId, userId),
          eq(scheduledTransactions.isActive, true),
          ...(targetedIds === null ? [] : [inArray(scheduledTransactions.id, targetedIds)]),
        ),
      );

    if (targetedIds !== null && schedules.length !== targetedIds.length) {
      throw new InvariantViolationError('Selected schedule is missing or inactive', {
        requested: targetedIds.length,
        found: schedules.length,
      });
    }

    if (schedules.length === 0) {
      return this.emptyResult(scope.kind === 'full' ? 'full' : 'targeted');
    }

    // Income date rules: biweekly cadence is anchored at biweekly_anchor; CLT pay
    // dates roll back to the previous business day. Load anchors by the schedule's
    // domainConfigId (which points at income_source_configs.id for income).
    const incomeDomainTypes = new Set<string>(getDomainTypesByGroup('income'));
    const incomeConfigIds = schedules
      .filter(
        (s) =>
          s.domainType != null && incomeDomainTypes.has(s.domainType) && s.domainConfigId != null,
      )
      .map((s) => s.domainConfigId as string);
    const incomeConfigRows =
      incomeConfigIds.length > 0
        ? await this.db
            .select({
              id: incomeSourceConfigs.id,
              biweeklyAnchor: incomeSourceConfigs.biweeklyAnchor,
            })
            .from(incomeSourceConfigs)
            .where(inArray(incomeSourceConfigs.id, incomeConfigIds))
        : [];
    const incomeAnchorByConfigId = new Map(
      incomeConfigRows.map((c) => [c.id, c.biweeklyAnchor] as const),
    );

    // Load existing transactions that were materialized (have scheduledTransactionId).
    // Filter is_reversed=false to mirror the tx_materialized_unique partial index:
    // a reversed row must NOT block re-materialization of its replacement.
    const scheduleIds = schedules.map((s) => s.id);
    const existingTxs = await this.db
      .select({
        scheduledTransactionId: transactions.scheduledTransactionId,
        date: transactions.date,
        installmentNumber: transactions.installmentNumber,
        billingMonth: transactions.billingMonth,
        billingYear: transactions.billingYear,
      })
      .from(transactions)
      .where(
        and(
          eq(transactions.userId, userId),
          inArray(transactions.scheduledTransactionId, scheduleIds),
          eq(transactions.isReversed, false),
        ),
      );

    // Classify an existing tx's schedule (income? monthly-family?) by id.
    const scheduleById = new Map(schedules.map((s) => [s.id, s] as const));

    // Build dedup set: "scheduleId|YYYY-MM-DD"
    const existingSet = new Set<string>();
    // Occurrence-identity dedup for INSTALLMENT schedules: "scheduleId|installmentNumber".
    // The date-keyed set above misses a duplicate when the schedule's start_date is
    // later edited and the computed occurrence date shifts — computeOccurrenceDates
    // then yields a new date for the SAME installment_number, so a second row would
    // be inserted. Keying by installment_number catches that.
    const existingOccSet = new Set<string>();
    // Month-bucket dedup for MONTHLY-family income: "scheduleId|YYYY-MM". Non-installment
    // income (totalOccurrences=NULL) never hits existingOccSet, so a preserved PAID income
    // row whose recomputed occurrence date shifts (CLT business-day roll, holiday/due_day
    // edit) would slip past the date-only key and insert a silent monthly duplicate.
    const existingMonthSet = new Set<string>();
    // Billing-month-bucket dedup for monthly recurring CREDIT-CARD FIXED CHARGES:
    // "scheduleId|YYYY-M" (BILLING period). These are non-installment (totalOccurrences
    // NULL) so existingOccSet never covers them, and the local-calendar-day date
    // normalization (commit c959f92) can shift a fixed charge's occurrence ACROSS a month
    // boundary (e.g. prior-month-end 2026-03-31 -> billing-month-start 2026-04-01), which
    // both the date-only key AND the date-MONTH key (used for income) miss. The BILLING
    // month is invariant under that shift, so it is the stable identity here. Income rows
    // carry no billing period, so they never populate this set.
    const existingBillingMonthSet = new Set<string>();
    for (const tx of existingTxs) {
      if (tx.scheduledTransactionId && tx.date) {
        const dateStr = dateToKey(tx.date);
        existingSet.add(`${tx.scheduledTransactionId}|${dateStr}`);
        const sched = scheduleById.get(tx.scheduledTransactionId);
        if (
          sched?.domainType != null &&
          incomeDomainTypes.has(sched.domainType) &&
          MONTHLY_FAMILY_FREQ.has(sched.frequency)
        ) {
          existingMonthSet.add(`${tx.scheduledTransactionId}|${dateStr.slice(0, 7)}`);
        }
      }
      if (tx.scheduledTransactionId && tx.installmentNumber != null) {
        existingOccSet.add(`${tx.scheduledTransactionId}|${tx.installmentNumber}`);
      }
      if (
        tx.scheduledTransactionId &&
        tx.installmentNumber == null &&
        tx.billingMonth != null &&
        tx.billingYear != null
      ) {
        const sched = scheduleById.get(tx.scheduledTransactionId);
        if (
          sched != null &&
          sched.totalOccurrences == null &&
          MONTHLY_FAMILY_FREQ.has(sched.frequency)
        ) {
          existingBillingMonthSet.add(
            `${tx.scheduledTransactionId}|${tx.billingYear}-${tx.billingMonth}`,
          );
        }
      }
    }

    // Manual reconciliation rows (scheduled_transaction_id IS NULL) represent real
    // charges with no schedule link. They are invisible to the scheduleId-keyed set
    // above, so without this the materializer inserts a schedule-linked duplicate
    // beside each one. Build a content-keyed multiset; each manual row "covers" at
    // most one matching occurrence (count-capped, so genuine extra occurrences still
    // materialize).
    const manualRows = await this.db
      .select({
        sourceAccountId: transactions.sourceAccountId,
        destinationAccountId: transactions.destinationAccountId,
        amount: transactions.amount,
        billingMonth: transactions.billingMonth,
        billingYear: transactions.billingYear,
        installmentNumber: transactions.installmentNumber,
        domainType: transactions.domainType,
      })
      .from(transactions)
      .where(
        and(
          eq(transactions.userId, userId),
          isNull(transactions.scheduledTransactionId),
          eq(transactions.isReversed, false),
        ),
      );

    const manualCounts = new Map<string, number>();
    for (const r of manualRows) {
      const k = contentKey(r);
      manualCounts.set(k, (manualCounts.get(k) ?? 0) + 1);
    }

    // Load all account types and credit card configs we may need
    const allAccountIds = new Set<string>();
    for (const s of schedules) {
      allAccountIds.add(s.sourceAccountId);
      allAccountIds.add(s.destinationAccountId);
    }

    const accountRows = await this.db
      .select({ id: accounts.id, type: accounts.type, isActive: accounts.isActive })
      .from(accounts)
      .where(and(eq(accounts.userId, userId), inArray(accounts.id, [...allAccountIds])));

    const accountTypeMap = new Map<string, AccountType>(accountRows.map((a) => [a.id, a.type]));
    const activeAccountMap = new Map(accountRows.map((account) => [account.id, account.isActive]));

    // Load credit card configs for all credit card destination accounts
    const creditCardAccountIds = accountRows
      .filter((a) => a.type === 'credit_card')
      .map((a) => a.id);

    const ccConfigMap = await loadEffectiveCardConfigs(this.db, userId, creditCardAccountIds);

    let created = 0;
    let skipped = 0;
    let closedPeriodSkipped = 0;
    const closedPeriods = new Set(
      (
        await this.db
          .select({ month: monthClosings.month, year: monthClosings.year })
          .from(monthClosings)
          .where(and(eq(monthClosings.userId, userId), eq(monthClosings.status, 'closed')))
      ).map((p) => `${p.year}-${String(p.month).padStart(2, '0')}`),
    );
    let candidateOccurrences = 0;
    let inactiveAccountSkipped = 0;
    const invalidSchedules: InvalidSchedule[] = [];
    const affectedAccountIds = new Set<string>();
    let pendingRows: (typeof transactions.$inferInsert)[] = [];

    const flushPendingRows = async () => {
      if (pendingRows.length === 0) return;
      const inserted = await this.db
        .insert(transactions)
        .values(pendingRows)
        .onConflictDoNothing()
        .returning({
          sourceAccountId: transactions.sourceAccountId,
          destinationAccountId: transactions.destinationAccountId,
        });
      created += inserted.length;
      skipped += pendingRows.length - inserted.length;
      for (const row of inserted) {
        affectedAccountIds.add(row.sourceAccountId);
        affectedAccountIds.add(row.destinationAccountId);
      }
      pendingRows = [];
    };

    for (const schedule of schedules) {
      if (schedule.startingOccurrence !== 1) {
        console.warn(
          `[materializer] skipping schedule ${schedule.id} (user ${schedule.userId}): ` +
            `startingOccurrence=${schedule.startingOccurrence}, expected 1 - ` +
            'legacy poison pill, will NOT materialize until normalized',
        );
        invalidSchedules.push({
          scheduleId: schedule.id,
          startingOccurrence: schedule.startingOccurrence,
        });
        continue;
      }

      const startDateObj = toLocalCalendarDay(
        schedule.startDate instanceof Date ? schedule.startDate : new Date(schedule.startDate),
      );

      const isIncomeSchedule =
        schedule.domainType != null && incomeDomainTypes.has(schedule.domainType);
      const anchorRaw =
        isIncomeSchedule && schedule.domainConfigId
          ? incomeAnchorByConfigId.get(schedule.domainConfigId)
          : null;
      const cadenceStart =
        schedule.frequency === 'biweekly' && anchorRaw
          ? toLocalCalendarDay(new Date(anchorRaw))
          : startDateObj;

      const rawOccurrences = computeOccurrenceDates({
        frequency: schedule.frequency as Parameters<typeof computeOccurrenceDates>[0]['frequency'],
        startDate: cadenceStart,
        dueDay: schedule.dueDay ?? null,
        totalOccurrences: schedule.totalOccurrences ?? null,
        startingOccurrence: schedule.startingOccurrence,
        horizonMonths: (() => {
          const now = new Date();
          const monthsFromStart =
            (now.getFullYear() - cadenceStart.getFullYear()) * 12 +
            (now.getMonth() - cadenceStart.getMonth());
          return monthsFromStart > 0 ? monthsFromStart + horizonMonths : horizonMonths;
        })(),
        ...(schedule.endDate !== null &&
          schedule.endDate !== undefined && {
            endDate: toLocalCalendarDay(
              schedule.endDate instanceof Date ? schedule.endDate : new Date(schedule.endDate),
            ),
          }),
      });

      // CLT salaries anticipate to the previous business day when the nominal day
      // is a weekend/holiday (e.g. day 15 on a Sunday → Friday).
      const occurrences =
        schedule.domainType === 'income_clt'
          ? rawOccurrences.map((o) => ({ ...o, date: previousBusinessDay(o.date) }))
          : rawOccurrences;

      const sourceType = accountTypeMap.get(schedule.sourceAccountId);
      const destType = accountTypeMap.get(schedule.destinationAccountId);

      if (!sourceType || !destType) {
        throw new InvariantViolationError(
          `Schedule ${schedule.id} references account missing from accountTypeMap`,
          {
            scheduleId: schedule.id,
            sourceAccountId: schedule.sourceAccountId,
            destinationAccountId: schedule.destinationAccountId,
            missing: !sourceType ? 'source' : 'destination',
          },
        );
      }

      if (
        activeAccountMap.get(schedule.sourceAccountId) !== true ||
        activeAccountMap.get(schedule.destinationAccountId) !== true
      ) {
        inactiveAccountSkipped += occurrences.length;
        continue;
      }

      const type = deriveTransactionType(sourceType, destType);
      const ccConfig = ccConfigMap.get(schedule.destinationAccountId);

      const isMonthlyFreq =
        schedule.frequency != null && MONTHLY_FAMILY_FREQ.has(schedule.frequency);
      const isMonthlyFamilyIncome = isIncomeSchedule && isMonthlyFreq;

      for (const { date, occurrenceNumber } of occurrences) {
        candidateOccurrences++;
        const dateStr = dateToKey(date);
        const dedupKey = `${schedule.id}|${dateStr}`;

        if (existingSet.has(dedupKey)) {
          skipped++;
          continue;
        }

        // Month-bucket dedup for monthly-family income: a preserved PAID row in this
        // calendar month already covers the occurrence even when the recomputed date
        // shifted off the paid row's exact day. Suppress the would-be duplicate.
        const monthKey = isMonthlyFamilyIncome ? `${schedule.id}|${dateStr.slice(0, 7)}` : null;
        if (monthKey !== null && existingMonthSet.has(monthKey)) {
          skipped++;
          continue;
        }

        // Shared single source of truth: installments are billed by index
        // (firstBilling + occurrence), other cc charges by closing-day date.
        const billingPeriod = assignOccurrenceBilling({
          isCreditCard: destType === 'credit_card',
          totalOccurrences: schedule.totalOccurrences,
          firstBillingMonth: schedule.firstBillingMonth,
          firstBillingYear: schedule.firstBillingYear,
          occurrenceNumber,
          date,
          closingDay: ccConfig ? ccConfig.closingDay : null,
        });
        if (
          closedPeriods.has(dateStr.slice(0, 7)) ||
          (billingPeriod &&
            closedPeriods.has(
              `${billingPeriod.billingYear}-${String(billingPeriod.billingMonth).padStart(2, '0')}`,
            ))
        ) {
          skipped++;
          closedPeriodSkipped++;
          continue;
        }

        const isInstallment = schedule.totalOccurrences !== null;

        // Occurrence-identity dedup for installment schedules: if a non-reversed row
        // for this (schedule, installment_number) already exists — even under a
        // different date because the start_date was edited — skip to avoid a second
        // row for the same installment.
        if (isInstallment && existingOccSet.has(`${schedule.id}|${occurrenceNumber}`)) {
          skipped++;
          continue;
        }

        // Billing-month-bucket dedup for monthly recurring card fixed charges: a row
        // already billed in this (schedule, billing year+month) covers the recomputed
        // occurrence even when its exact date shifted across a month boundary (the
        // date-only/date-month keys above miss that). billingPeriod is non-null for a
        // non-installment charge only when the destination is a credit card, so this
        // never touches income/family-loan/other non-card schedules.
        const billingMonthKey =
          !isInstallment && isMonthlyFreq && billingPeriod !== null
            ? `${schedule.id}|${billingPeriod.billingYear}-${billingPeriod.billingMonth}`
            : null;
        if (billingMonthKey !== null && existingBillingMonthSet.has(billingMonthKey)) {
          skipped++;
          continue;
        }

        // If a manual reconciliation row already covers this exact charge, consume
        // it and skip — prevents the schedule-linked duplicate.
        const occurrenceAmount = resolveScheduledAmount(
          schedule.amount,
          schedule.amountChanges,
          billingPeriod,
        );
        const candidateKey = contentKey({
          sourceAccountId: schedule.sourceAccountId,
          destinationAccountId: schedule.destinationAccountId,
          amount: occurrenceAmount,
          billingMonth: billingPeriod?.billingMonth ?? null,
          billingYear: billingPeriod?.billingYear ?? null,
          installmentNumber: isInstallment ? occurrenceNumber : null,
          domainType: schedule.domainType ?? null,
        });
        const manualAvail = manualCounts.get(candidateKey) ?? 0;
        if (manualAvail > 0) {
          manualCounts.set(candidateKey, manualAvail - 1);
          skipped++;
          continue;
        }

        if (schedule.currency !== 'BRL') {
          logger.warn(
            { scheduleId: schedule.id, currency: schedule.currency },
            'materializing non-BRL transaction: accounts.current_balance will mix currencies; canonical cash is WalletCashService',
          );
        }

        const occurrenceDates =
          preservedDates.get(dedupKey) ??
          preservedDates.get(
            occurrenceIdentity(
              schedule.id,
              dateStr,
              isInstallment ? occurrenceNumber : null,
              billingPeriod?.billingMonth ?? null,
              billingPeriod?.billingYear ?? null,
              isMonthlyFreq,
            ),
          );
        pendingRows.push({
          userId,
          sourceAccountId: schedule.sourceAccountId,
          destinationAccountId: schedule.destinationAccountId,
          amount: occurrenceAmount,
          currency: schedule.currency,
          type,
          description: schedule.description,
          date,
          scheduledTransactionId: schedule.id,
          purchaseDate: occurrenceDates?.purchaseDate ?? schedule.purchaseDate,
          purchaseDateSource: occurrenceDates?.purchaseDate
            ? occurrenceDates.purchaseDateSource
            : schedule.purchaseDateSource,
          postedDate: occurrenceDates?.postedDate ?? null,
          postedDateSource: occurrenceDates?.postedDateSource ?? 'unknown',
          ...(schedule.categoryId !== null &&
            schedule.categoryId !== undefined && { categoryId: schedule.categoryId }),
          ...(schedule.notes !== null && schedule.notes !== undefined && { notes: schedule.notes }),
          ...(schedule.domainType !== null &&
            schedule.domainType !== undefined && { domainType: schedule.domainType }),
          ...(billingPeriod !== null && {
            billingMonth: billingPeriod.billingMonth,
            billingYear: billingPeriod.billingYear,
          }),
          ...(isInstallment &&
            schedule.totalOccurrences !== null && {
              installmentNumber: occurrenceNumber,
              totalInstallments: schedule.totalOccurrences,
            }),
          ...occurrenceDates?.classification,
        });

        existingSet.add(dedupKey);
        if (isInstallment) {
          existingOccSet.add(`${schedule.id}|${occurrenceNumber}`);
        }
        if (monthKey !== null) {
          existingMonthSet.add(monthKey);
        }
        if (billingMonthKey !== null) {
          existingBillingMonthSet.add(billingMonthKey);
        }
        if (pendingRows.length >= MATERIALIZATION_BATCH_SIZE) {
          await flushPendingRows();
        }
      }
    }

    await flushPendingRows();
    for (const accountId of affectedAccountIds) {
      await this.accountService.recalculateBalance(accountId);
    }

    return {
      created,
      skipped,
      invalidSchedules,
      scope: scope.kind === 'full' ? 'full' : 'targeted',
      schedulesLoaded: schedules.length,
      existingRowsLoaded: existingTxs.length,
      manualRowsLoaded: manualRows.length,
      candidateOccurrences,
      closedPeriodSkipped,
      inactiveAccountSkipped,
    };
  }

  /**
   * Serialises a full materialize() behind a per-user transaction-scoped advisory
   * lock so concurrent callers (e.g. the scheduled.router force-materialize
   * mutation racing a getBill-triggered guard run) cannot both insert duplicate
   * rows. Use this from request handlers that call materialize directly.
   */
  async materializeForUserLocked(
    userId: string,
    horizonMonths: number = 12,
  ): Promise<MaterializeResult> {
    return this.materialize(userId, horizonMonths);
  }

  /**
   * Deletes unpaid, non-reversed materialized transactions for a single schedule
   * and re-materializes them. Preserves manually-marked paid rows and reversals
   * so history and reconciliations stay intact. Runs inside a transaction,
   * serialised per-user with the same advisory lock as materializeForUserLocked.
   */
  async rematerializeForSchedule(
    userId: string,
    scheduleId: string,
    horizonMonths: number = 12,
  ): Promise<MaterializeResult> {
    return this.materializeScheduleChanges(userId, {
      scope: 'targeted',
      fillScheduleIds: [],
      rebuildScheduleIds: [scheduleId],
      horizonMonths,
    });
  }

  /**
   * Rematerializes all schedules for a user. Same delete-policy as
   * rematerializeForSchedule: preserves paid/reversed rows.
   */
  async rematerializeAllForUser(
    userId: string,
    horizonMonths: number = 12,
  ): Promise<MaterializeResult> {
    return this.materializeScheduleChanges(userId, {
      scope: 'full-rebuild',
      fillScheduleIds: [],
      rebuildScheduleIds: [],
      horizonMonths,
    });
  }
}
