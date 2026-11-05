import { createHash } from 'node:crypto';
import type { DbExecutor, FaturaImportItemsJson } from '@fc/db';
import {
  accounts,
  creditCardBills,
  creditCardConfigs,
  faturaImports,
  monthClosings,
  scheduledTransactions,
  transactions,
} from '@fc/db';
import {
  analyzeInstallmentReversals,
  canManuallyLinkFaturaItem,
  computeParsedTotals,
  type ExpectedItem,
  type FaturaMatchResult,
  FaturaValidationError,
  flattenParsedCards,
  type HistoryItem,
  matchFaturaItems,
  type ParsedFatura,
  type ParsedItem,
  resolveBillingFromDueDate,
  resolveScheduledAmount,
  resolveStatementCycle,
  type StatementCycle,
  StatementCycleError,
  suggestNewItemActions,
  totalsDelta,
  validateStatementImportPeriod,
} from '@fc/domain';
import { TRPCError } from '@trpc/server';
import Decimal from 'decimal.js';
import { and, desc, eq, gt, gte, inArray, ne, or } from 'drizzle-orm';
import { acquireBillLocks } from '../lib/bill-lock.ts';
import { runWithMaterializationLock } from '../lib/materialization-lock.ts';
import { openCardPeriod } from '../lib/open-card-period.ts';
import type { PurchaseTarget } from '../lib/purchase-input.ts';
import { AccountService } from './account.service.ts';
import { AuditService } from './audit.service.ts';
import { CreditCardFlowService } from './credit-card-flow.service.ts';
import { CreditCardLifecycleService } from './credit-card-lifecycle.service.ts';
import { FaturaMatchRuleService } from './fatura-match-rule.service.ts';
import {
  buildBulkManualFaturaPrompt,
  parseBulkManualFaturaResponse,
} from './fatura-parse/bulk-manual-fatura.ts';
import { ClaudeFaturaParser } from './fatura-parse/claude-pdf-parser.ts';
import {
  buildManualFaturaPrompt,
  parseManualFaturaResponse,
} from './fatura-parse/manual-fatura.ts';
import { STATEMENT_PARSER_LIMITS, validateStatementPdf } from './fatura-parse/pdf-validation.ts';
import { getFaturaProfile } from './fatura-parse/profiles.ts';
import type { FaturaPdfParser } from './fatura-parse/types.ts';
import { FinancialEventService } from './financial-event.service.ts';
import { MaterializationCoordinator } from './materialization-coordinator.service.ts';
import { ScheduledService } from './scheduled.service.ts';
import { StatementCycleService } from './statement-cycle.service.ts';
import { TransactionService } from './transaction.service.ts';

export type ManualFaturaProvider = 'claude' | 'chatgpt' | 'other';

type SelectedStatementPeriod = { month: number; year: number };

type BulkManualManifestItem = {
  reference: string;
  cardAccountId: string;
  cardName: string;
  profileId: string;
  profile: ReturnType<typeof getFaturaProfile>;
};

export type BulkManualFaturaResult = {
  reference: string;
  cardAccountId: string;
  importId?: string;
  error?: string;
};

export type ApplyDecision =
  | { kind: 'skip' }
  | {
      kind: 'add_expense';
      suggestionIndex: number;
      targetCardAccountId: string;
      description: string;
      amount: string;
      categoryId?: string;
    }
  | {
      kind: 'add_installment';
      suggestionIndex: number;
      targetCardAccountId: string;
      description: string;
      amount: string;
      totalInstallments: number;
      currentInstallmentNumber: number;
      categoryId?: string;
    }
  | {
      kind: 'add_fixed_charge';
      suggestionIndex: number;
      targetCardAccountId: string;
      description: string;
      amount: string;
      categoryId?: string;
    }
  | {
      kind: 'add_refund';
      suggestionIndex: number;
      targetCardAccountId: string;
      description: string;
      amount: string;
    }
  | { kind: 'update_expense'; transactionId: string; amount: string; description?: string }
  | {
      kind: 'update_schedule_amount';
      scheduleId: string;
      amount: string;
      scope?: 'cycle' | 'from_cycle';
    }
  | {
      kind: 'edit_installment';
      scheduleId: string;
      description: string;
      amount: string;
      totalInstallments: number;
      currentInstallmentNumber: number;
      categoryId?: string | null;
    }
  | { kind: 'resolve_reversal_bundle'; bundleIndex: number; action: 'apply' | 'keep' }
  | { kind: 'link_statement_item'; suggestionIndex: number; transactionId: string }
  | { kind: 'resolve_missing_item'; transactionId: string; action: 'keep' | 'remove' };

export class FaturaImportService {
  private readonly accountService: AccountService;
  private readonly cardLifecycle: CreditCardLifecycleService;
  private readonly now: () => Date;
  private readonly parser: FaturaPdfParser | undefined;

  constructor(
    private readonly db: DbExecutor,
    options: { parser?: FaturaPdfParser; now?: () => Date } = {},
  ) {
    this.accountService = new AccountService(db);
    this.cardLifecycle = new CreditCardLifecycleService(db);
    this.now = options.now ?? (() => new Date());
    this.parser = options.parser;
  }

  async createDraft(
    userId: string,
    input: {
      cardAccountId: string;
      fileName: string;
      pdfBase64: string;
      externalConsent?: boolean;
      selectedPeriod?: SelectedStatementPeriod;
    },
    signal?: AbortSignal,
  ) {
    await this.cardLifecycle.assertActiveCard(userId, input.cardAccountId);
    const card = await this.accountService.getById(userId, input.cardAccountId);
    if (card.type !== 'credit_card') {
      throw new TRPCError({ code: 'BAD_REQUEST', message: 'A conta informada não é um cartão' });
    }
    await validateStatementPdf(input.pdfBase64);
    if (input.externalConsent !== true)
      throw new TRPCError({
        code: 'PRECONDITION_FAILED',
        message: 'statement.externalConsentRequired',
        cause: { i18nKey: 'statement.externalConsentRequired' },
      });
    const documentHash = createHash('sha256')
      .update(Buffer.from(input.pdfBase64, 'base64'))
      .digest('hex');
    const existing = await this.findDocument(userId, input.cardAccountId, documentHash);
    if (existing) {
      assertSelectedPeriod(existing, input.selectedPeriod);
      return existing;
    }
    const timeout = AbortSignal.timeout(STATEMENT_PARSER_LIMITS.timeoutMs);
    const cancellation = signal ? AbortSignal.any([signal, timeout]) : timeout;
    cancellation.throwIfAborted();

    const [config] = await this.db
      .select()
      .from(creditCardConfigs)
      .where(eq(creditCardConfigs.accountId, input.cardAccountId));
    const profile = getFaturaProfile(config?.billParserType);
    const parser = this.resolveParser();
    let fatura: ParsedFatura;
    try {
      fatura = await parser.parse({ pdfBase64: input.pdfBase64, profile, signal: cancellation });
      cancellation.throwIfAborted();
    } catch (error) {
      if (cancellation.aborted)
        throw new TRPCError({
          code: 'TIMEOUT',
          message: signal?.aborted ? 'statement.cancelled' : 'statement.parserTimeout',
          cause: { i18nKey: signal?.aborted ? 'statement.cancelled' : 'statement.parserTimeout' },
        });
      throw error;
    }

    return this.createDraftFromParsed(userId, {
      cardAccountId: input.cardAccountId,
      fileName: input.fileName,
      fatura,
      modelUsed: parser.model,
      documentHash,
      selectedPeriod: input.selectedPeriod,
      profileId: profile.id,
    });
  }

  async getManualPrompt(userId: string, cardAccountId: string) {
    await this.cardLifecycle.assertActiveCard(userId, cardAccountId);
    const profile = await this.getOwnedCardProfile(userId, cardAccountId);
    return { profileId: profile.id, prompt: buildManualFaturaPrompt(profile) };
  }

  async createManualDraft(
    userId: string,
    input: {
      cardAccountId: string;
      provider: ManualFaturaProvider;
      responseJson: string;
      selectedPeriod?: SelectedStatementPeriod;
    },
  ) {
    await this.cardLifecycle.assertActiveCard(userId, input.cardAccountId);
    const profile = await this.getOwnedCardProfile(userId, input.cardAccountId);
    let fatura: ParsedFatura;
    try {
      fatura = parseManualFaturaResponse(input.responseJson);
    } catch {
      throw new TRPCError({
        code: 'BAD_REQUEST',
        message: 'Resposta JSON da fatura é inválida ou não segue o schema esperado',
      });
    }
    return this.createDraftFromParsed(userId, {
      cardAccountId: input.cardAccountId,
      fileName: 'manual-response.json',
      fatura,
      modelUsed: `manual-${input.provider}`,
      selectedPeriod: input.selectedPeriod,
      profileId: profile.id,
    });
  }

  async getBulkManualPrompt(userId: string, cardAccountIds: string[]) {
    const manifest = await this.getBulkManualManifest(userId, cardAccountIds);
    return {
      prompt: buildBulkManualFaturaPrompt(manifest),
      manifest: manifest.map(({ reference, cardAccountId, cardName, profileId }) => ({
        reference,
        cardAccountId,
        cardName,
        profileId,
      })),
    };
  }

  async createManualBulkDrafts(
    userId: string,
    input: { cardAccountIds: string[]; provider: ManualFaturaProvider; responseJson: string },
  ): Promise<BulkManualFaturaResult[]> {
    const manifest = await this.getBulkManualManifest(userId, input.cardAccountIds);
    let statements: ReturnType<typeof parseBulkManualFaturaResponse>;
    try {
      statements = parseBulkManualFaturaResponse(
        input.responseJson,
        manifest.map((item) => item.reference),
      );
    } catch {
      throw new TRPCError({
        code: 'BAD_REQUEST',
        message: 'Resposta JSON do lote é inválida ou não segue o schema esperado',
      });
    }

    const statementsByReference = new Map(
      statements.map((statement) => [statement.reference, statement]),
    );
    const results: BulkManualFaturaResult[] = [];
    for (const item of manifest) {
      const statement = statementsByReference.get(item.reference);
      if (statement === undefined || statement.status === 'invalid') {
        results.push({
          reference: item.reference,
          cardAccountId: item.cardAccountId,
          error: statement?.message ?? 'Fatura ausente na resposta do lote',
        });
        continue;
      }
      try {
        const draft = await this.createDraftFromParsed(userId, {
          cardAccountId: item.cardAccountId,
          fileName: 'manual-bulk-response.json',
          fatura: statement.fatura,
          modelUsed: `manual-bulk-${input.provider}`,
          profileId: item.profileId,
        });
        results.push({
          reference: item.reference,
          cardAccountId: item.cardAccountId,
          importId: draft.id,
        });
      } catch {
        results.push({
          reference: item.reference,
          cardAccountId: item.cardAccountId,
          error: 'Não foi possível criar o rascunho desta fatura',
        });
      }
    }
    return results;
  }

  private async createDraftFromParsed(
    userId: string,
    input: {
      cardAccountId: string;
      fileName: string;
      fatura: ParsedFatura;
      modelUsed: string;
      profileId: string;
      documentHash?: string;
      selectedPeriod?: SelectedStatementPeriod;
    },
  ) {
    const { fatura } = input;
    const documentHash =
      input.documentHash ?? createHash('sha256').update(JSON.stringify(fatura)).digest('hex');
    const previous = await this.findDocument(userId, input.cardAccountId, documentHash);
    if (previous) {
      assertSelectedPeriod(previous, input.selectedPeriod);
      return previous;
    }
    const card = await this.accountService.getById(userId, input.cardAccountId);
    const cycleAccountId = card.parentAccountId ?? card.id;
    if (card.parentAccountId) await this.accountService.getById(userId, cycleAccountId);
    const [cycleConfig] = await this.db
      .select()
      .from(creditCardConfigs)
      .where(eq(creditCardConfigs.accountId, cycleAccountId));

    let billing: StatementCycle;
    try {
      billing = input.selectedPeriod
        ? resolveStatementCycle({
            reference: 'closing',
            ...input.selectedPeriod,
            closingDate: fatura.closingDate,
            dueDate: fatura.dueDate,
            config: cycleConfig,
          })
        : resolveBillingFromDueDate(fatura.dueDate, {
            closingDay: cycleConfig?.closingDay ?? null,
            dueDay: cycleConfig?.dueDay ?? null,
            closingDate: fatura.closingDate,
          });
    } catch (error) {
      if (error instanceof FaturaValidationError || error instanceof StatementCycleError) {
        throw new TRPCError({
          code: 'BAD_REQUEST',
          message: error.message,
          cause: { i18nKey: error.message },
        });
      }
      throw error;
    }

    const parsed = flattenParsedCards(fatura.cards);
    const totals = computeParsedTotals(parsed);
    const consolidatedCards = await this.loadConsolidatedCards(userId, input.cardAccountId);
    const cardAccountIds = consolidatedCards.map((card) => card.id);
    const [expected, history, learnedRules] = await Promise.all([
      this.loadExpectedItems(userId, cardAccountIds, billing.billingMonth, billing.billingYear),
      this.loadHistory(userId, cardAccountIds, billing.billingMonth, billing.billingYear),
      new FaturaMatchRuleService(this.db).listForCards(userId, cardAccountIds),
    ]);
    const paidTotalsBySchedule = await this.loadPaidTotalsBySchedule(userId, expected);
    const reversalAnalysis = analyzeConsolidatedInstallmentReversals(
      parsed,
      expected,
      paidTotalsBySchedule,
      input.cardAccountId,
      consolidatedCards,
    );
    const matchResult = matchConsolidatedFaturaItems(
      reversalAnalysis.parsed,
      reversalAnalysis.expected,
      input.cardAccountId,
      consolidatedCards,
      learnedRules,
    );
    const suggestions = suggestNewItemActions(matchResult.newOnFatura, history).map(
      (suggestion) => ({
        ...suggestion,
        targetCardAccountId: resolveTargetCardAccountId(
          suggestion.parsed,
          input.cardAccountId,
          consolidatedCards,
        ),
      }),
    );
    const itemsJson: FaturaImportItemsJson = {
      cardAccounts: consolidatedCards,
      snapshotHash: expectedSnapshot(expected),
      ignoredPreviousBalance: fatura.ignoredPreviousBalance ?? null,
      ignoredPayments: fatura.ignoredPayments ?? null,
      matchResult,
      suggestions,
      reversalBundles: reversalAnalysis.reversalBundles,
      blockedGroups: reversalAnalysis.blockedGroups,
      totals: {
        ...totals,
        delta: totalsDelta(totals.netTotal, fatura.statedTotal),
      },
    };

    return this.db.transaction(async (tx) => {
      await tx
        .select({ id: accounts.id })
        .from(accounts)
        .where(and(eq(accounts.id, input.cardAccountId), eq(accounts.userId, userId)))
        .for('update');
      const duplicate = await new FaturaImportService(tx).findDocument(
        userId,
        input.cardAccountId,
        documentHash,
      );
      if (duplicate) return duplicate;
      const [row] = await tx
        .insert(faturaImports)
        .values({
          userId,
          cardAccountId: input.cardAccountId,
          billingMonth: billing.billingMonth,
          billingYear: billing.billingYear,
          dueDate: fatura.dueDate,
          closingDate: billing.closingDate,
          closingDateSource: billing.closingDateSource,
          dueDateSource: billing.dueDateSource,
          periodConfidence: billing.confidence,
          documentHash,
          fileName: input.fileName,
          profileId: input.profileId,
          modelUsed: input.modelUsed,
          parsedTotal: totals.netTotal,
          statedTotal: fatura.statedTotal,
          itemsJson,
        })
        .returning();
      if (row === undefined) {
        throw new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message: 'Falha ao gravar rascunho' });
      }
      return row;
    });
  }

  private async findDocument(userId: string, cardAccountId: string, documentHash: string) {
    const [row] = await this.db
      .select()
      .from(faturaImports)
      .where(
        and(
          eq(faturaImports.userId, userId),
          eq(faturaImports.cardAccountId, cardAccountId),
          eq(faturaImports.documentHash, documentHash),
          ne(faturaImports.status, 'discarded'),
        ),
      );
    return row;
  }

  async get(userId: string, importId: string) {
    const [row] = await this.db
      .select()
      .from(faturaImports)
      .where(and(eq(faturaImports.id, importId), eq(faturaImports.userId, userId)));
    if (row === undefined) {
      throw new TRPCError({ code: 'NOT_FOUND', message: 'Importação não encontrada' });
    }
    return { ...row, itemsJson: exposeLegacyDraftSafety(row.itemsJson) };
  }

  async listByCard(userId: string, cardAccountId: string) {
    await this.accountService.getById(userId, cardAccountId);
    return this.db
      .select()
      .from(faturaImports)
      .where(and(eq(faturaImports.userId, userId), eq(faturaImports.cardAccountId, cardAccountId)))
      .orderBy(desc(faturaImports.createdAt));
  }

  async discard(userId: string, importId: string) {
    const [row] = await this.db
      .update(faturaImports)
      .set({ status: 'discarded', updatedAt: this.now() })
      .where(
        and(
          eq(faturaImports.id, importId),
          eq(faturaImports.userId, userId),
          eq(faturaImports.status, 'draft'),
        ),
      )
      .returning({ id: faturaImports.id, status: faturaImports.status });
    if (row === undefined) {
      throw new TRPCError({ code: 'BAD_REQUEST', message: 'Só rascunhos podem ser descartados' });
    }
    return row;
  }

  async apply(
    userId: string,
    input: {
      importId: string;
      expenseAccountId: string;
      decisions: ApplyDecision[];
      acknowledgeTotalMismatch?: boolean;
      reviewedPeriod?: { month: number; year: number };
    },
  ) {
    return this.db.transaction(async (transaction) =>
      runWithMaterializationLock(transaction, userId, async ({ db: tx }) => {
        const [draft] = await tx
          .select()
          .from(faturaImports)
          .where(and(eq(faturaImports.id, input.importId), eq(faturaImports.userId, userId)))
          .for('update');
        if (draft === undefined) {
          throw new TRPCError({ code: 'NOT_FOUND', message: 'Importação não encontrada' });
        }
        if (draft.status === 'applied')
          return {
            id: draft.id,
            status: draft.status,
            reconciliation: draft.itemsJson.reconciliation,
          };
        if (draft.status !== 'draft') {
          throw new TRPCError({
            code: 'CONFLICT',
            message: 'Importação não está em draft; já foi aplicada ou descartada',
          });
        }
        const lifecycle = new CreditCardLifecycleService(tx);
        await lifecycle.assertActiveCard(userId, draft.cardAccountId);
        const targetCardIds = new Set(
          input.decisions.flatMap((decision) =>
            'targetCardAccountId' in decision ? [decision.targetCardAccountId] : [],
          ),
        );
        for (const targetCardId of targetCardIds) {
          await lifecycle.assertActiveCard(userId, targetCardId);
        }
        const [closedMonth] = await tx
          .select()
          .from(monthClosings)
          .where(
            and(
              eq(monthClosings.userId, userId),
              eq(monthClosings.month, draft.billingMonth),
              eq(monthClosings.year, draft.billingYear),
              eq(monthClosings.status, 'closed'),
            ),
          );
        let periodReview: { future: boolean; estimated: boolean };
        try {
          periodReview = validateStatementImportPeriod({
            cycle: {
              billingMonth: draft.billingMonth,
              billingYear: draft.billingYear,
              confidence: draft.periodConfidence,
            },
            selectedPeriod: input.reviewedPeriod ?? null,
            closed: Boolean(closedMonth),
            today: this.now().toISOString().slice(0, 10),
          });
        } catch (error) {
          if (error instanceof StatementCycleError)
            throw new TRPCError({
              code: 'PRECONDITION_FAILED',
              message: error.message,
              cause: { i18nKey: error.message },
            });
          throw error;
        }
        assertDraftCanBeApplied(draft.itemsJson);
        assertStaticApplyDecisions(draft.itemsJson, input.decisions);
        assertAcceptedTotal(
          draft.itemsJson,
          draft.statedTotal,
          input.decisions,
          input.acknowledgeTotalMismatch ?? false,
        );

        const affectedCardIds = new Set<string>([
          draft.cardAccountId,
          ...draft.itemsJson.cardAccounts.map((card) => card.id),
        ]);
        for (const pair of draft.itemsJson.matchResult.review) {
          affectedCardIds.add(pair.expected.cardAccountId);
        }
        for (const item of draft.itemsJson.matchResult.missingInSystem) {
          affectedCardIds.add(item.cardAccountId);
        }
        for (const bundle of draft.itemsJson.reversalBundles ?? []) {
          if (bundle.expected !== null) affectedCardIds.add(bundle.expected.cardAccountId);
        }
        for (const decision of input.decisions) {
          if (
            decision.kind === 'add_expense' ||
            decision.kind === 'add_installment' ||
            decision.kind === 'add_fixed_charge' ||
            decision.kind === 'add_refund'
          ) {
            affectedCardIds.add(decision.targetCardAccountId);
          }
        }
        await acquireBillLocks(
          tx,
          userId,
          [...affectedCardIds].map((cardAccountId) => ({
            cardAccountId,
            month: draft.billingMonth,
            year: draft.billingYear,
          })),
        );

        const [frozenBill] = await tx
          .select({ id: creditCardBills.id })
          .from(creditCardBills)
          .where(
            and(
              inArray(creditCardBills.creditCardAccountId, [...affectedCardIds]),
              eq(creditCardBills.month, draft.billingMonth),
              eq(creditCardBills.year, draft.billingYear),
              ne(creditCardBills.status, 'open'),
            ),
          );
        if (frozenBill)
          throw new TRPCError({
            code: 'PRECONDITION_FAILED',
            message: 'statement.monthClosed',
            cause: { i18nKey: 'statement.monthClosed' },
          });
        const scopedService = new FaturaImportService(tx, { now: this.now });
        if (draft.itemsJson.snapshotHash) {
          const current = await scopedService.loadExpectedItems(
            userId,
            draft.itemsJson.cardAccounts.map((card) => card.id),
            draft.billingMonth,
            draft.billingYear,
          );
          if (expectedSnapshot(current) !== draft.itemsJson.snapshotHash)
            throw new TRPCError({
              code: 'CONFLICT',
              message: 'statement.staleDraft',
              cause: { i18nKey: 'statement.staleDraft' },
            });
        }

        const accountService = new AccountService(tx);
        await accountService.getById(userId, input.expenseAccountId);
        const coordinator = new MaterializationCoordinator(tx);
        const materializationBatch = await coordinator.startBatch(userId);
        const flow = new CreditCardFlowService(tx, { capturePurchases: false });
        const capturePdf = async (
          parsed: ParsedItem,
          cardAccountId: string,
          identity: string,
          target: PurchaseTarget,
          application: 'linked' | 'created',
          confirmation: 'posted' | 'retracted' = 'posted',
          reviewed?: Parameters<FinancialEventService['recordApplied']>[4],
        ) => {
          await new FinancialEventService(tx).recordApplied(
            userId,
            {
              source: 'pdf',
              sourceScope: 'statement',
              externalId: `${draft.id}:${identity}`,
              sourceVersion: 1,
              parserVersion: `${draft.profileId}:${draft.modelUsed}`.slice(0, 80),
              observedAt: this.now(),
              data: {
                cardAccountId,
                description: parsed.description.trim().slice(0, 200),
                amount: parsed.amountBRL,
                currency: 'BRL',
                amountMeaning:
                  parsed.installmentCurrent && parsed.installmentTotal
                    ? 'installment'
                    : 'purchase_total',
                kind: parsed.isRefund ? 'refund' : 'purchase',
                purchaseDate: parsed.purchaseDate,
                postedDate: parsed.postedDate ?? null,
                installmentNumber: parsed.installmentCurrent,
                totalInstallments: parsed.installmentTotal,
                confirmation,
              },
            },
            target,
            application,
            reviewed,
          );
        };
        const transactionService = new TransactionService(tx);
        const scheduledService = new ScheduledService(tx);
        const matchRuleService = new FaturaMatchRuleService(tx);
        const reviewedTransactions = new Map(
          draft.itemsJson.matchResult.review.map((pair) => [
            pair.expected.transactionId,
            pair.expected,
          ]),
        );
        const reviewedSchedules = new Map(
          draft.itemsJson.matchResult.review.flatMap((pair) =>
            pair.expected.scheduleId === null
              ? []
              : [[pair.expected.scheduleId, pair.expected] as const],
          ),
        );
        const missingTransactions = new Map(
          draft.itemsJson.matchResult.missingInSystem.map(
            (item) => [item.transactionId, item] as const,
          ),
        );
        const usedSuggestions = new Set<number>();
        const usedReversalBundles = new Set<number>();
        const removedMissingSchedules = new Set<string>();
        const acceptedMatches = [
          ...draft.itemsJson.matchResult.matched,
          ...draft.itemsJson.matchResult.review.filter((pair) =>
            input.decisions.some(
              (decision) =>
                ('transactionId' in decision &&
                  decision.kind === 'update_expense' &&
                  decision.transactionId === pair.expected.transactionId) ||
                ('scheduleId' in decision && decision.scheduleId === pair.expected.scheduleId),
            ),
          ),
        ];

        for (const decision of input.decisions) {
          switch (decision.kind) {
            case 'skip':
              break;
            case 'add_expense': {
              assertSuggestionDecision(draft.itemsJson, decision, usedSuggestions);
              const created = await flow.addOneTimeExpense(userId, {
                creditCardAccountId: decision.targetCardAccountId,
                expenseAccountId: input.expenseAccountId,
                description: decision.description,
                amount: decision.amount,
                billingMonth: draft.billingMonth,
                billingYear: draft.billingYear,
                purchaseDate:
                  draft.itemsJson.suggestions[decision.suggestionIndex].parsed.purchaseDate,
                postedDate: draft.itemsJson.suggestions[decision.suggestionIndex].parsed.postedDate,
                purchaseDateSource: 'institution',
                postedDateSource: 'institution',
                ...(decision.categoryId === undefined ? {} : { categoryId: decision.categoryId }),
              });
              await capturePdf(
                draft.itemsJson.suggestions[decision.suggestionIndex].parsed,
                decision.targetCardAccountId,
                `suggestion:${decision.suggestionIndex}`,
                { transactionId: created.transaction.id },
                'created',
                'posted',
                {
                  description: decision.description,
                  amount: decision.amount,
                  amountMeaning: 'purchase_total',
                  installmentNumber: null,
                  totalInstallments: null,
                  categoryId: decision.categoryId,
                },
              );
              break;
            }
            case 'add_installment': {
              assertSuggestionDecision(draft.itemsJson, decision, usedSuggestions);
              const created = await flow.addInstallment(
                userId,
                {
                  creditCardAccountId: decision.targetCardAccountId,
                  expenseAccountId: input.expenseAccountId,
                  description: decision.description,
                  amount: decision.amount,
                  totalInstallments: decision.totalInstallments,
                  currentInstallmentNumber: decision.currentInstallmentNumber,
                  currentBillingMonth: draft.billingMonth,
                  currentBillingYear: draft.billingYear,
                  purchaseDate:
                    draft.itemsJson.suggestions[decision.suggestionIndex].parsed.purchaseDate,
                  purchaseDateSource: 'institution',
                  ...(decision.categoryId === undefined ? {} : { categoryId: decision.categoryId }),
                },
                materializationBatch,
              );
              await capturePdf(
                draft.itemsJson.suggestions[decision.suggestionIndex].parsed,
                decision.targetCardAccountId,
                `suggestion:${decision.suggestionIndex}`,
                { scheduleId: created.schedule.id },
                'created',
                'posted',
                {
                  description: decision.description,
                  amount: decision.amount,
                  amountMeaning: 'installment',
                  installmentNumber: decision.currentInstallmentNumber,
                  totalInstallments: decision.totalInstallments,
                  categoryId: decision.categoryId,
                },
              );
              break;
            }
            case 'add_fixed_charge': {
              assertSuggestionDecision(draft.itemsJson, decision, usedSuggestions);
              const targetCardAccountId = decision.targetCardAccountId;
              const [config] = await tx
                .select({ dueDay: creditCardConfigs.dueDay })
                .from(creditCardConfigs)
                .where(eq(creditCardConfigs.accountId, targetCardAccountId));
              if (config === undefined) {
                throw new TRPCError({
                  code: 'BAD_REQUEST',
                  message: 'Config do cartão não encontrada',
                });
              }
              const created = await flow.addFixedCharge(
                userId,
                {
                  creditCardAccountId: targetCardAccountId,
                  expenseAccountId: input.expenseAccountId,
                  description: decision.description,
                  amount: decision.amount,
                  startDate: new Date(draft.billingYear, draft.billingMonth - 1, 1),
                  dueDay: config.dueDay,
                  firstBillingMonth: draft.billingMonth,
                  firstBillingYear: draft.billingYear,
                  ...(decision.categoryId === undefined ? {} : { categoryId: decision.categoryId }),
                },
                materializationBatch,
              );
              await capturePdf(
                draft.itemsJson.suggestions[decision.suggestionIndex].parsed,
                decision.targetCardAccountId,
                `suggestion:${decision.suggestionIndex}`,
                {
                  scheduleId: created.schedule.id,
                  billingMonth: draft.billingMonth,
                  billingYear: draft.billingYear,
                },
                'created',
                'posted',
                {
                  description: decision.description,
                  amount: decision.amount,
                  amountMeaning: 'purchase_total',
                  installmentNumber: null,
                  totalInstallments: null,
                  categoryId: decision.categoryId,
                },
              );
              break;
            }
            case 'add_refund': {
              assertSuggestionDecision(draft.itemsJson, decision, usedSuggestions);
              const created = await flow.addRefund(userId, {
                expenseAccountId: input.expenseAccountId,
                creditCardAccountId: decision.targetCardAccountId,
                amount: decision.amount,
                description: decision.description,
                billingMonth: draft.billingMonth,
                billingYear: draft.billingYear,
                purchaseDate:
                  draft.itemsJson.suggestions[decision.suggestionIndex].parsed.purchaseDate,
                postedDate: draft.itemsJson.suggestions[decision.suggestionIndex].parsed.postedDate,
                purchaseDateSource: 'institution',
                postedDateSource: 'institution',
              });
              await capturePdf(
                draft.itemsJson.suggestions[decision.suggestionIndex].parsed,
                decision.targetCardAccountId,
                `suggestion:${decision.suggestionIndex}`,
                { transactionId: created.transaction.id },
                'created',
                'posted',
                {
                  description: decision.description,
                  amount: decision.amount,
                  amountMeaning: 'purchase_total',
                  installmentNumber: null,
                  totalInstallments: null,
                },
              );
              break;
            }
            case 'update_expense': {
              const expected = reviewedTransactions.get(decision.transactionId);
              if (
                expected === undefined ||
                (expected.domainType !== 'credit_card_expense' &&
                  expected.domainType !== 'credit_card_refund')
              ) {
                throw invalidReviewDecision();
              }
              await updateReviewedExpense(
                tx,
                userId,
                expected.cardAccountId,
                decision,
                expected.domainType,
              );
              break;
            }
            case 'update_schedule_amount': {
              const expected = reviewedSchedules.get(decision.scheduleId);
              if (
                expected === undefined ||
                (expected.domainType !== 'credit_card_fixed_charge' &&
                  expected.domainType !== 'credit_card_refund')
              ) {
                throw invalidReviewDecision();
              }
              await updateReviewedSchedule(
                tx,
                userId,
                expected.cardAccountId,
                draft.billingMonth,
                draft.billingYear,
                decision,
                expected.domainType,
              );
              break;
            }
            case 'edit_installment':
              if (!reviewedSchedules.has(decision.scheduleId)) throw invalidReviewDecision();
              await assertScheduleOnCard(
                tx,
                userId,
                decision.scheduleId,
                reviewedSchedules.get(decision.scheduleId)?.cardAccountId ?? draft.cardAccountId,
                'credit_card_installment',
              );
              await flow.editInstallment(
                userId,
                {
                  scheduleId: decision.scheduleId,
                  description: decision.description,
                  amount: decision.amount,
                  totalInstallments: decision.totalInstallments,
                  currentInstallmentNumber: decision.currentInstallmentNumber,
                  currentBillingMonth: draft.billingMonth,
                  currentBillingYear: draft.billingYear,
                  categoryId: decision.categoryId ?? null,
                },
                materializationBatch,
              );
              break;
            case 'resolve_reversal_bundle': {
              const bundle = assertReversalDecision(draft.itemsJson, decision, usedReversalBundles);
              if (decision.action === 'keep' || bundle.expected === null) break;
              const scheduleId = bundle.expected.scheduleId;
              if (scheduleId === null) throw invalidReversalDecision();
              await assertScheduleOnCard(
                tx,
                userId,
                scheduleId,
                bundle.expected.cardAccountId,
                'credit_card_installment',
              );
              const paidTotal = await loadCurrentPaidTotal(tx, userId, scheduleId);
              if (!paidTotal.eq(bundle.netRefundBRL)) {
                throw new TRPCError({
                  code: 'CONFLICT',
                  message:
                    'As parcelas pagas mudaram desde a revisão; reimporte a fatura antes de aplicar',
                });
              }
              await scheduledService.deleteSchedule(userId, scheduleId);
              const canceledPurchase = bundle.charges[0];
              if (canceledPurchase)
                await capturePdf(
                  canceledPurchase,
                  bundle.expected.cardAccountId,
                  `reversal:${decision.bundleIndex}:purchase`,
                  { scheduleId },
                  'linked',
                  'retracted',
                );
              if (paidTotal.gt(0)) {
                const created = await flow.addRefund(userId, {
                  expenseAccountId: input.expenseAccountId,
                  creditCardAccountId: bundle.expected.cardAccountId,
                  amount: paidTotal.toFixed(2),
                  description: `Estorno ${bundle.expected.description}`,
                  purchaseDate: bundle.refund.purchaseDate,
                  postedDate: bundle.refund.postedDate,
                  purchaseDateSource: 'institution',
                  postedDateSource: 'institution',
                  billingMonth: draft.billingMonth,
                  billingYear: draft.billingYear,
                });
                await capturePdf(
                  bundle.refund,
                  bundle.expected.cardAccountId,
                  `reversal:${decision.bundleIndex}:refund`,
                  { transactionId: created.transaction.id },
                  'created',
                );
              }
              break;
            }
            case 'link_statement_item': {
              const { expected, parsed } = assertLinkDecision(
                draft.itemsJson,
                decision,
                usedSuggestions,
              );
              acceptedMatches.push({ expected, parsed, score: 1 });
              if (
                expected.domainType === 'credit_card_fixed_charge' &&
                expected.scheduleId !== null
              ) {
                if (expected.isPaid !== true) {
                  await updateReviewedSchedule(
                    tx,
                    userId,
                    expected.cardAccountId,
                    draft.billingMonth,
                    draft.billingYear,
                    {
                      kind: 'update_schedule_amount',
                      scheduleId: expected.scheduleId,
                      amount: parsed.amountBRL,
                    },
                  );
                }
                await matchRuleService.learn(userId, {
                  cardAccountId: expected.cardAccountId,
                  rawDescription: parsed.description,
                  scheduleId: expected.scheduleId,
                });
                break;
              }

              if (expected.domainType === 'credit_card_refund') {
                if (expected.isPaid !== true) {
                  if (expected.scheduleId !== null) {
                    await updateReviewedSchedule(
                      tx,
                      userId,
                      expected.cardAccountId,
                      draft.billingMonth,
                      draft.billingYear,
                      {
                        kind: 'update_schedule_amount',
                        scheduleId: expected.scheduleId,
                        amount: parsed.amountBRL,
                      },
                      'credit_card_refund',
                    );
                  } else {
                    await updateReviewedExpense(
                      tx,
                      userId,
                      expected.cardAccountId,
                      {
                        kind: 'update_expense',
                        transactionId: expected.transactionId,
                        amount: parsed.amountBRL,
                      },
                      'credit_card_refund',
                    );
                  }
                }
                if (expected.scheduleId !== null) {
                  await matchRuleService.learn(userId, {
                    cardAccountId: expected.cardAccountId,
                    rawDescription: parsed.description,
                    scheduleId: expected.scheduleId,
                  });
                }
                break;
              }

              if (expected.isPaid === true) break;

              if (
                expected.domainType === 'credit_card_installment' &&
                expected.scheduleId !== null
              ) {
                await assertScheduleOnCard(
                  tx,
                  userId,
                  expected.scheduleId,
                  expected.cardAccountId,
                  'credit_card_installment',
                );
                await flow.editInstallment(
                  userId,
                  {
                    scheduleId: expected.scheduleId,
                    description: expected.description,
                    amount: parsed.amountBRL,
                    totalInstallments: parsed.installmentTotal ?? expected.totalInstallments ?? 1,
                    currentInstallmentNumber:
                      parsed.installmentCurrent ?? expected.installmentNumber ?? 1,
                    currentBillingMonth: draft.billingMonth,
                    currentBillingYear: draft.billingYear,
                  },
                  materializationBatch,
                );
                break;
              }

              if (expected.domainType === 'credit_card_expense') {
                await updateReviewedExpense(tx, userId, expected.cardAccountId, {
                  kind: 'update_expense',
                  transactionId: expected.transactionId,
                  amount: parsed.amountBRL,
                });
                break;
              }

              throw invalidMissingDecision();
            }
            case 'resolve_missing_item': {
              const expected = missingTransactions.get(decision.transactionId);
              if (expected === undefined) throw invalidMissingDecision();
              await resolveMissingItem(
                tx,
                userId,
                draft.billingMonth,
                draft.billingYear,
                expected,
                decision.action,
                scheduledService,
                transactionService,
                removedMissingSchedules,
              );
              break;
            }
          }
        }
        if (usedReversalBundles.size !== (draft.itemsJson.reversalBundles?.length ?? 0)) {
          throw new TRPCError({
            code: 'BAD_REQUEST',
            message: 'Decida todos os cancelamentos identificados antes de aplicar',
          });
        }

        for (const { expected, parsed } of acceptedMatches) {
          if (
            expected.domainType === 'credit_card_installment' &&
            expected.scheduleId &&
            parsed.purchaseDate
          ) {
            await tx
              .update(scheduledTransactions)
              .set({ purchaseDate: parsed.purchaseDate, purchaseDateSource: 'institution' })
              .where(
                and(
                  eq(scheduledTransactions.id, expected.scheduleId),
                  eq(scheduledTransactions.userId, userId),
                ),
              );
          }
        }
        await materializationBatch.finalize();
        for (const { expected, parsed } of acceptedMatches) {
          const dates = {
            ...(parsed.purchaseDate
              ? { purchaseDate: parsed.purchaseDate, purchaseDateSource: 'institution' as const }
              : {}),
            ...(parsed.postedDate
              ? { postedDate: parsed.postedDate, postedDateSource: 'institution' as const }
              : {}),
          };
          if (Object.keys(dates).length === 0) continue;
          await tx
            .update(transactions)
            .set(dates)
            .where(
              and(
                eq(transactions.userId, userId),
                eq(transactions.destinationAccountId, expected.cardAccountId),
                eq(transactions.billingMonth, draft.billingMonth),
                eq(transactions.billingYear, draft.billingYear),
                expected.scheduleId
                  ? eq(transactions.scheduledTransactionId, expected.scheduleId)
                  : eq(transactions.id, expected.transactionId),
              ),
            );
        }

        const cycleService = new StatementCycleService(tx);
        for (const cardAccountId of affectedCardIds) {
          await cycleService.persist(
            userId,
            { cardAccountId, month: draft.billingMonth, year: draft.billingYear },
            {
              billingMonth: draft.billingMonth,
              billingYear: draft.billingYear,
              closingDate: draft.closingDate,
              dueDate: draft.dueDate,
              closingDateSource: draft.closingDateSource,
              dueDateSource: draft.dueDateSource,
              confidence: draft.periodConfidence,
              reason: draft.periodConfidence === 'confirmed' ? 'actual_dates' : 'configuration',
            },
          );
        }

        const composition = await scopedService.loadExpectedItems(
          userId,
          [...affectedCardIds],
          draft.billingMonth,
          draft.billingYear,
        );
        const compositionTotal = composition.reduce(
          (sum, item) =>
            item.domainType === 'credit_card_refund'
              ? sum.minus(item.amountBRL)
              : sum.plus(item.amountBRL),
          new Decimal(0),
        );
        const compositionDelta =
          draft.statedTotal === null ? null : compositionTotal.minus(draft.statedTotal).toFixed(2);
        const reconciliation: NonNullable<FaturaImportItemsJson['reconciliation']> = {
          status:
            draft.statedTotal === null
              ? 'unknown'
              : compositionDelta === '0.00' && draft.itemsJson.totals.delta === '0.00'
                ? 'reconciled'
                : 'difference',
          compositionDelta,
          documentDelta: draft.itemsJson.totals.delta,
          ...periodReview,
        };
        const appliedAt = this.now();
        for (const [index, { expected, parsed }] of acceptedMatches.entries()) {
          await capturePdf(
            parsed,
            expected.cardAccountId,
            `matched:${index}`,
            expected.scheduleId
              ? {
                  scheduleId: expected.scheduleId,
                  billingMonth: draft.billingMonth,
                  billingYear: draft.billingYear,
                }
              : { transactionId: expected.transactionId },
            'linked',
          );
        }
        await new AuditService(tx).log(userId, 'apply', 'fatura_import', draft.id, undefined, {
          decisions: input.decisions,
          reviewedPeriod: input.reviewedPeriod,
          reconciliation,
          ...(input.acknowledgeTotalMismatch === true ? { acknowledgeTotalMismatch: true } : {}),
        });
        const [applied] = await tx
          .update(faturaImports)
          .set({
            status: 'applied',
            appliedAt,
            updatedAt: appliedAt,
            itemsJson: { ...draft.itemsJson, reconciliation },
          })
          .where(
            and(
              eq(faturaImports.id, input.importId),
              eq(faturaImports.userId, userId),
              eq(faturaImports.status, 'draft'),
            ),
          )
          .returning({ id: faturaImports.id, status: faturaImports.status });
        if (applied === undefined) {
          throw new TRPCError({ code: 'CONFLICT', message: 'Rascunho já aplicado' });
        }
        return { ...applied, reconciliation };
      }),
    );
  }

  private async getOwnedCardProfile(userId: string, cardAccountId: string) {
    const card = await this.accountService.getById(userId, cardAccountId);
    if (card.type !== 'credit_card') {
      throw new TRPCError({ code: 'BAD_REQUEST', message: 'A conta informada não é um cartão' });
    }
    const [config] = await this.db
      .select({ billParserType: creditCardConfigs.billParserType })
      .from(creditCardConfigs)
      .where(eq(creditCardConfigs.accountId, cardAccountId));
    return getFaturaProfile(config?.billParserType);
  }

  private async getBulkManualManifest(userId: string, cardAccountIds: string[]) {
    if (cardAccountIds.length === 0 || cardAccountIds.length > 20) {
      throw new TRPCError({ code: 'BAD_REQUEST', message: 'Selecione entre 1 e 20 cartões' });
    }
    if (new Set(cardAccountIds).size !== cardAccountIds.length) {
      throw new TRPCError({ code: 'BAD_REQUEST', message: 'Não repita cartões no mesmo lote' });
    }

    const cards = await this.db
      .select({
        id: accounts.id,
        name: accounts.name,
        type: accounts.type,
        parentAccountId: accounts.parentAccountId,
      })
      .from(accounts)
      .where(and(eq(accounts.userId, userId), inArray(accounts.id, cardAccountIds)));
    if (cards.length !== cardAccountIds.length) {
      throw new TRPCError({ code: 'NOT_FOUND', message: 'Cartão não encontrado' });
    }
    const cardsById = new Map(cards.map((card) => [card.id, card]));
    if (
      cardAccountIds.some((id) => {
        const card = cardsById.get(id);
        return card?.type !== 'credit_card' || card.parentAccountId !== null;
      })
    ) {
      throw new TRPCError({
        code: 'BAD_REQUEST',
        message: 'O lote aceita apenas cartões principais',
      });
    }

    const configs = await this.db
      .select({
        accountId: creditCardConfigs.accountId,
        billParserType: creditCardConfigs.billParserType,
      })
      .from(creditCardConfigs)
      .where(inArray(creditCardConfigs.accountId, cardAccountIds));
    const configsByAccountId = new Map(configs.map((config) => [config.accountId, config]));

    return cardAccountIds.map((cardAccountId, index): BulkManualManifestItem => {
      const card = cardsById.get(cardAccountId);
      if (card === undefined)
        throw new TRPCError({ code: 'NOT_FOUND', message: 'Cartão não encontrado' });
      const profile = getFaturaProfile(configsByAccountId.get(cardAccountId)?.billParserType);
      return {
        reference: `card-${index + 1}`,
        cardAccountId,
        cardName: card.name,
        profileId: profile.id,
        profile,
      };
    });
  }

  private resolveParser(): FaturaPdfParser {
    if (this.parser !== undefined) return this.parser;
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (apiKey === undefined || apiKey.length === 0) {
      throw new TRPCError({
        code: 'PRECONDITION_FAILED',
        message: 'ANTHROPIC_API_KEY não configurada — importação indisponível',
      });
    }
    return new ClaudeFaturaParser({ apiKey });
  }

  private async loadExpectedItems(
    userId: string,
    cardAccountIds: string[],
    month: number,
    year: number,
  ): Promise<ExpectedItem[]> {
    const rows = await this.db
      .select()
      .from(transactions)
      .where(
        and(
          eq(transactions.userId, userId),
          inArray(transactions.destinationAccountId, cardAccountIds),
          eq(transactions.billingMonth, month),
          eq(transactions.billingYear, year),
          eq(transactions.isReversed, false),
        ),
      );
    return rows
      .filter((row) => row.domainType !== 'bill_payment')
      .map((row) => ({
        transactionId: row.id,
        cardAccountId: row.destinationAccountId,
        scheduleId: row.scheduledTransactionId,
        description: row.description,
        amountBRL: new Decimal(row.amount).abs().toFixed(2),
        date: row.date.toISOString().slice(0, 10),
        domainType: row.domainType,
        installmentNumber: row.installmentNumber,
        totalInstallments: row.totalInstallments,
        isPaid: row.isPaid,
      }));
  }

  private async loadHistory(
    userId: string,
    cardAccountIds: string[],
    month: number,
    year: number,
  ): Promise<HistoryItem[]> {
    const periods: Array<{ month: number; year: number }> = [];
    let cursorMonth = month;
    let cursorYear = year;
    for (let index = 0; index < 3; index += 1) {
      cursorMonth -= 1;
      if (cursorMonth === 0) {
        cursorMonth = 12;
        cursorYear -= 1;
      }
      periods.push({ month: cursorMonth, year: cursorYear });
    }
    const years = [...new Set(periods.map((period) => period.year))];
    const wanted = new Set(periods.map((period) => `${period.year}-${period.month}`));
    const rows = await this.db
      .select()
      .from(transactions)
      .where(
        and(
          eq(transactions.userId, userId),
          inArray(transactions.destinationAccountId, cardAccountIds),
          eq(transactions.isReversed, false),
          inArray(transactions.billingYear, years),
        ),
      );
    return rows.flatMap((row) => {
      if (
        row.domainType === 'bill_payment' ||
        row.billingMonth === null ||
        row.billingYear === null ||
        !wanted.has(`${row.billingYear}-${row.billingMonth}`)
      ) {
        return [];
      }
      return [
        {
          description: row.description,
          amountBRL: new Decimal(row.amount).abs().toFixed(2),
          billingMonth: row.billingMonth,
          billingYear: row.billingYear,
          domainType: row.domainType,
        },
      ];
    });
  }

  private async loadPaidTotalsBySchedule(
    userId: string,
    expected: ExpectedItem[],
  ): Promise<Record<string, string>> {
    const scheduleIds = [
      ...new Set(expected.flatMap((item) => (item.scheduleId === null ? [] : [item.scheduleId]))),
    ];
    if (scheduleIds.length === 0) return {};
    const rows = await this.db
      .select({
        scheduleId: transactions.scheduledTransactionId,
        amount: transactions.amount,
      })
      .from(transactions)
      .where(
        and(
          eq(transactions.userId, userId),
          inArray(transactions.scheduledTransactionId, scheduleIds),
          eq(transactions.isPaid, true),
          eq(transactions.isReversed, false),
        ),
      );
    const totals: Record<string, Decimal> = {};
    for (const row of rows) {
      if (row.scheduleId === null) continue;
      totals[row.scheduleId] = (totals[row.scheduleId] ?? new Decimal(0)).plus(
        new Decimal(row.amount).abs(),
      );
    }
    return Object.fromEntries(
      Object.entries(totals).map(([scheduleId, total]) => [scheduleId, total.toFixed(2)]),
    );
  }

  private async loadConsolidatedCards(userId: string, cardAccountId: string) {
    return this.db
      .select({ id: accounts.id, name: accounts.name, parentAccountId: accounts.parentAccountId })
      .from(accounts)
      .where(
        and(
          eq(accounts.userId, userId),
          eq(accounts.type, 'credit_card'),
          eq(accounts.isActive, true),
          or(eq(accounts.id, cardAccountId), eq(accounts.parentAccountId, cardAccountId)),
        ),
      );
  }
}

function assertSelectedPeriod(
  draft: { billingMonth: number; billingYear: number },
  selected?: SelectedStatementPeriod,
) {
  if (selected && (selected.month !== draft.billingMonth || selected.year !== draft.billingYear))
    throw new TRPCError({
      code: 'CONFLICT',
      message: 'statement.cycleConflict',
      cause: { i18nKey: 'statement.cycleConflict' },
    });
}

function expectedSnapshot(items: ExpectedItem[]): string {
  return createHash('sha256')
    .update(
      JSON.stringify([...items].sort((a, b) => a.transactionId.localeCompare(b.transactionId))),
    )
    .digest('hex');
}

function invalidReviewDecision(): TRPCError {
  return new TRPCError({
    code: 'BAD_REQUEST',
    message: 'Decisão não pertence aos itens de review desta fatura',
  });
}

function invalidReversalDecision(): TRPCError {
  return new TRPCError({
    code: 'BAD_REQUEST',
    message: 'Decisão não pertence aos cancelamentos identificados nesta fatura',
  });
}

function invalidMissingDecision(): TRPCError {
  return new TRPCError({
    code: 'BAD_REQUEST',
    message: 'Decisão não pertence aos itens fora da fatura',
  });
}

function assertDraftCanBeApplied(itemsJson: FaturaImportItemsJson): void {
  if ((itemsJson.blockedGroups?.length ?? 0) > 0) {
    throw new TRPCError({
      code: 'CONFLICT',
      message:
        'Há grupos de parcelas duplicadas sem crédito inequívoco; corrija a extração e reimporte a fatura',
    });
  }
  if (itemsJson.reversalBundles !== undefined || itemsJson.blockedGroups !== undefined) return;

  const legacyAnalysis = analyzeInstallmentReversals({
    parsed: itemsJson.suggestions.map((suggestion) => suggestion.parsed),
    expected: itemsJson.matchResult.missingInSystem,
    paidTotalsBySchedule: {},
  });
  if (legacyAnalysis.reversalBundles.length > 0 || legacyAnalysis.blockedGroups.length > 0) {
    throw new TRPCError({
      code: 'CONFLICT',
      message:
        'Este rascunho antigo contém grupos de parcelas suspeitos; reimporte a fatura com a versão atual',
    });
  }
}

function exposeLegacyDraftSafety(itemsJson: FaturaImportItemsJson): FaturaImportItemsJson {
  if (itemsJson.reversalBundles !== undefined || itemsJson.blockedGroups !== undefined) {
    return itemsJson;
  }
  const analysis = analyzeInstallmentReversals({
    parsed: itemsJson.suggestions.map((suggestion) => suggestion.parsed),
    expected: itemsJson.matchResult.missingInSystem,
    paidTotalsBySchedule: {},
  });
  return {
    ...itemsJson,
    reversalBundles: [],
    blockedGroups: [
      ...analysis.blockedGroups,
      ...analysis.reversalBundles.map((bundle) => ({
        items: bundle.charges,
        reason: 'multiple_installments_same_purchase' as const,
      })),
    ],
  };
}

function assertStaticApplyDecisions(
  itemsJson: FaturaImportItemsJson,
  decisions: ApplyDecision[],
): void {
  const usedSuggestions = new Set<number>();
  const usedTransactions = new Set<string>();
  const usedSchedules = new Set<string>();
  const usedMissingTransactions = new Set<string>();
  const missingScheduleActions = new Map<string, 'keep' | 'remove'>();
  const reviewTransactions = new Map(
    itemsJson.matchResult.review.map((pair) => [pair.expected.transactionId, pair] as const),
  );
  const reviewSchedules = new Map(
    itemsJson.matchResult.review.flatMap((pair) =>
      pair.expected.scheduleId === null ? [] : [[pair.expected.scheduleId, pair] as const],
    ),
  );
  const missingTransactions = new Map(
    itemsJson.matchResult.missingInSystem.map((item) => [item.transactionId, item] as const),
  );

  for (const decision of decisions) {
    if (decision.kind === 'link_statement_item') {
      const { expected } = assertLinkDecision(itemsJson, decision, usedSuggestions);
      if (usedMissingTransactions.has(expected.transactionId)) {
        throw invalidMissingDecision();
      }
      usedMissingTransactions.add(expected.transactionId);
      continue;
    }
    if ('suggestionIndex' in decision) {
      assertSuggestionDecision(itemsJson, decision, usedSuggestions);
      continue;
    }
    if (decision.kind === 'update_expense') {
      const pair = reviewTransactions.get(decision.transactionId);
      if (
        pair === undefined ||
        usedTransactions.has(decision.transactionId) ||
        new Decimal(decision.amount).abs().toFixed(2) !== pair.parsed.amountBRL
      ) {
        throw invalidReviewDecision();
      }
      usedTransactions.add(decision.transactionId);
      continue;
    }
    if (decision.kind === 'resolve_missing_item') {
      const item = missingTransactions.get(decision.transactionId);
      if (
        item === undefined ||
        usedMissingTransactions.has(decision.transactionId) ||
        (decision.action === 'remove' && item.isPaid === true) ||
        (item.scheduleId !== null &&
          missingScheduleActions.has(item.scheduleId) &&
          missingScheduleActions.get(item.scheduleId) !== decision.action)
      ) {
        throw invalidMissingDecision();
      }
      usedMissingTransactions.add(decision.transactionId);
      if (item.scheduleId !== null) {
        missingScheduleActions.set(item.scheduleId, decision.action);
      }
      continue;
    }
    if (decision.kind === 'update_schedule_amount' || decision.kind === 'edit_installment') {
      const pair = reviewSchedules.get(decision.scheduleId);
      if (
        pair === undefined ||
        usedSchedules.has(decision.scheduleId) ||
        new Decimal(decision.amount).abs().toFixed(2) !== pair.parsed.amountBRL
      ) {
        throw invalidReviewDecision();
      }
      if (
        decision.kind === 'edit_installment' &&
        (decision.currentInstallmentNumber !==
          (pair.parsed.installmentCurrent ?? pair.expected.installmentNumber ?? 1) ||
          decision.totalInstallments !==
            (pair.parsed.installmentTotal ?? pair.expected.totalInstallments ?? 1))
      ) {
        throw invalidReviewDecision();
      }
      usedSchedules.add(decision.scheduleId);
    }
  }
  assertNewItemsDoNotDuplicateMissing(itemsJson, decisions);
  if (usedMissingTransactions.size !== itemsJson.matchResult.missingInSystem.length) {
    throw new TRPCError({
      code: 'BAD_REQUEST',
      message: 'Decida todos os itens que estão no sistema mas fora da fatura antes de aplicar',
    });
  }
}

function assertAcceptedTotal(
  itemsJson: FaturaImportItemsJson,
  statedTotal: string | null,
  decisions: ApplyDecision[],
  acknowledged: boolean,
): void {
  const reversalBundles = itemsJson.reversalBundles ?? [];
  const reversalDecisions = decisions.filter(
    (decision): decision is Extract<ApplyDecision, { kind: 'resolve_reversal_bundle' }> =>
      decision.kind === 'resolve_reversal_bundle',
  );
  const missingDecisions = decisions.filter(
    (decision): decision is Extract<ApplyDecision, { kind: 'resolve_missing_item' }> =>
      decision.kind === 'resolve_missing_item',
  );
  if (
    reversalDecisions.length !== reversalBundles.length ||
    new Set(reversalDecisions.map((decision) => decision.bundleIndex)).size !==
      reversalDecisions.length ||
    reversalDecisions.some((decision) => reversalBundles[decision.bundleIndex] === undefined)
  ) {
    throw new TRPCError({
      code: 'BAD_REQUEST',
      message: 'Decida todos os cancelamentos identificados antes de aplicar',
    });
  }
  if (statedTotal === null) return;

  let accepted = new Decimal(0);
  for (const pair of itemsJson.matchResult.matched) {
    accepted = accepted.plus(signedParsedAmount(pair.parsed));
  }
  for (const pair of itemsJson.matchResult.review) {
    const acceptedFromStatement = decisions.some(
      (decision) =>
        (decision.kind === 'update_expense' &&
          decision.transactionId === pair.expected.transactionId) ||
        ((decision.kind === 'update_schedule_amount' || decision.kind === 'edit_installment') &&
          decision.scheduleId === pair.expected.scheduleId),
    );
    accepted = accepted.plus(
      acceptedFromStatement ? signedParsedAmount(pair.parsed) : signedExpectedAmount(pair.expected),
    );
  }
  for (const decision of decisions) {
    if (!('suggestionIndex' in decision)) continue;
    const parsed = itemsJson.suggestions[decision.suggestionIndex]?.parsed;
    if (parsed !== undefined) accepted = accepted.plus(signedParsedAmount(parsed));
  }
  for (const decision of reversalDecisions) {
    const bundle = reversalBundles[decision.bundleIndex];
    if (bundle === undefined) continue;
    if (decision.action === 'apply') {
      accepted = accepted.minus(bundle.netRefundBRL);
    } else if (bundle.expected !== null) {
      accepted = accepted.plus(signedExpectedAmount(bundle.expected));
    }
  }
  const missingByTransaction = new Map(
    itemsJson.matchResult.missingInSystem.map((item) => [item.transactionId, item] as const),
  );
  for (const decision of missingDecisions) {
    const item = missingByTransaction.get(decision.transactionId);
    if (decision.action === 'keep' && item !== undefined) {
      accepted = accepted.plus(signedExpectedAmount(item));
    }
  }

  if (accepted.minus(statedTotal).abs().gt('0.05') && !acknowledged) {
    throw new TRPCError({
      code: 'BAD_REQUEST',
      message:
        'O total das decisões não fecha com o total da fatura; confirme explicitamente a divergência',
    });
  }
}

function signedParsedAmount(item: FaturaImportItemsJson['suggestions'][number]['parsed']): Decimal {
  const amount = new Decimal(item.amountBRL);
  return item.isRefund ? amount.negated() : amount;
}

function signedExpectedAmount(
  item: FaturaImportItemsJson['matchResult']['missingInSystem'][number],
): Decimal {
  const amount = new Decimal(item.amountBRL);
  return item.domainType === 'credit_card_refund' ? amount.negated() : amount;
}

function matchConsolidatedFaturaItems(
  parsed: FaturaImportItemsJson['matchResult']['newOnFatura'],
  expected: ExpectedItem[],
  principalCardAccountId: string,
  cards: Array<{ id: string; name: string; parentAccountId: string | null }>,
  learnedRules: Array<{ cardAccountId: string; rawNormalized: string; scheduleId: string }>,
): FaturaMatchResult {
  const result: FaturaMatchResult = {
    matched: [],
    review: [],
    newOnFatura: [],
    missingInSystem: [],
  };
  for (const card of cards) {
    const partial = matchFaturaItems({
      parsed: parsed.filter(
        (item) => resolveTargetCardAccountId(item, principalCardAccountId, cards) === card.id,
      ),
      expected: expected.filter((item) => item.cardAccountId === card.id),
      aliases: {},
      learnedScheduleIds: Object.fromEntries(
        learnedRules
          .filter((rule) => rule.cardAccountId === card.id)
          .map((rule) => [rule.rawNormalized, rule.scheduleId]),
      ),
    });
    result.matched.push(...partial.matched);
    result.review.push(...partial.review);
    result.newOnFatura.push(...partial.newOnFatura);
    result.missingInSystem.push(...partial.missingInSystem);
  }
  result.newOnFatura.push(
    ...parsed.filter(
      (item) => resolveTargetCardAccountId(item, principalCardAccountId, cards) === null,
    ),
  );
  return result;
}

function analyzeConsolidatedInstallmentReversals(
  parsed: FaturaImportItemsJson['matchResult']['newOnFatura'],
  expected: ExpectedItem[],
  paidTotalsBySchedule: Record<string, string>,
  principalCardAccountId: string,
  cards: Array<{ id: string; name: string; parentAccountId: string | null }>,
) {
  const result = {
    parsed: [] as typeof parsed,
    expected: [] as ExpectedItem[],
    reversalBundles: [] as NonNullable<FaturaImportItemsJson['reversalBundles']>,
    blockedGroups: [] as NonNullable<FaturaImportItemsJson['blockedGroups']>,
  };
  for (const card of cards) {
    const analysis = analyzeInstallmentReversals({
      parsed: parsed.filter(
        (item) => resolveTargetCardAccountId(item, principalCardAccountId, cards) === card.id,
      ),
      expected: expected.filter((item) => item.cardAccountId === card.id),
      paidTotalsBySchedule,
    });
    result.parsed.push(...analysis.parsed);
    result.expected.push(...analysis.expected);
    result.reversalBundles.push(...analysis.reversalBundles);
    result.blockedGroups.push(...analysis.blockedGroups);
  }
  result.parsed.push(
    ...parsed.filter(
      (item) => resolveTargetCardAccountId(item, principalCardAccountId, cards) === null,
    ),
  );
  return result;
}

function assertSuggestionDecision(
  itemsJson: FaturaImportItemsJson,
  decision: Extract<ApplyDecision, { suggestionIndex: number; targetCardAccountId: string }>,
  usedSuggestions: Set<number>,
): void {
  const suggestion = itemsJson.suggestions[decision.suggestionIndex];
  if (
    suggestion === undefined ||
    usedSuggestions.has(decision.suggestionIndex) ||
    !itemsJson.cardAccounts.some((card) => card.id === decision.targetCardAccountId) ||
    new Decimal(decision.amount).abs().toFixed(2) !== suggestion.parsed.amountBRL ||
    (decision.kind === 'add_refund') !== suggestion.parsed.isRefund
  ) {
    throw new TRPCError({
      code: 'BAD_REQUEST',
      message: 'Decisão não pertence aos itens novos desta fatura',
    });
  }
  usedSuggestions.add(decision.suggestionIndex);
}

function assertNewItemsDoNotDuplicateMissing(
  itemsJson: FaturaImportItemsJson,
  decisions: ApplyDecision[],
): void {
  const additions = decisions.filter(
    (decision): decision is Extract<ApplyDecision, { targetCardAccountId: string }> =>
      'targetCardAccountId' in decision,
  );
  const selectedTargets = new Map(
    additions.map((decision) => [decision.suggestionIndex, decision.targetCardAccountId]),
  );
  const linkedSuggestions = new Set<number>();
  const linkedTransactions = new Set<string>();
  for (const decision of decisions) {
    if (decision.kind !== 'link_statement_item') continue;
    linkedSuggestions.add(decision.suggestionIndex);
    linkedTransactions.add(decision.transactionId);
  }

  for (const cardAccountId of new Set(additions.map((decision) => decision.targetCardAccountId))) {
    // Matching a single purchase fabricates uniqueness when several statement items share a value.
    const selectedCardMatch = matchFaturaItems({
      parsed: itemsJson.suggestions.flatMap((suggestion, index) =>
        !linkedSuggestions.has(index) &&
        (selectedTargets.get(index) ?? suggestion.targetCardAccountId) === cardAccountId
          ? [suggestion.parsed]
          : [],
      ),
      expected: itemsJson.matchResult.missingInSystem.filter(
        (expected) =>
          expected.cardAccountId === cardAccountId &&
          !linkedTransactions.has(expected.transactionId),
      ),
      aliases: {},
    });
    const conflicts = new Set(
      [...selectedCardMatch.matched, ...selectedCardMatch.review].map((pair) => pair.parsed),
    );
    if (
      additions.some((decision) => {
        const suggestion = itemsJson.suggestions[decision.suggestionIndex];
        return (
          decision.targetCardAccountId === cardAccountId &&
          suggestion !== undefined &&
          conflicts.has(suggestion.parsed)
        );
      })
    ) {
      throw new TRPCError({
        code: 'CONFLICT',
        message: 'O item já corresponde a um lançamento esperado do cartão selecionado',
      });
    }
  }
}

function assertLinkDecision(
  itemsJson: FaturaImportItemsJson,
  decision: Extract<ApplyDecision, { kind: 'link_statement_item' }>,
  usedSuggestions: Set<number>,
): {
  expected: FaturaImportItemsJson['matchResult']['missingInSystem'][number];
  parsed: FaturaImportItemsJson['suggestions'][number]['parsed'];
} {
  const suggestion = itemsJson.suggestions[decision.suggestionIndex];
  const expected = itemsJson.matchResult.missingInSystem.find(
    (item) => item.transactionId === decision.transactionId,
  );
  if (
    suggestion === undefined ||
    expected === undefined ||
    usedSuggestions.has(decision.suggestionIndex) ||
    !canLinkStatementItem(suggestion, expected)
  ) {
    throw invalidMissingDecision();
  }
  usedSuggestions.add(decision.suggestionIndex);
  return { expected, parsed: suggestion.parsed };
}

function canLinkStatementItem(
  suggestion: FaturaImportItemsJson['suggestions'][number],
  expected: FaturaImportItemsJson['matchResult']['missingInSystem'][number],
): boolean {
  return canManuallyLinkFaturaItem({
    parsed: suggestion.parsed,
    expected,
    targetCardAccountId: suggestion.targetCardAccountId,
  });
}

function assertReversalDecision(
  itemsJson: FaturaImportItemsJson,
  decision: Extract<ApplyDecision, { kind: 'resolve_reversal_bundle' }>,
  usedBundles: Set<number>,
): NonNullable<FaturaImportItemsJson['reversalBundles']>[number] {
  const bundle = itemsJson.reversalBundles?.[decision.bundleIndex];
  if (bundle === undefined || usedBundles.has(decision.bundleIndex)) {
    throw invalidReversalDecision();
  }
  usedBundles.add(decision.bundleIndex);
  return bundle;
}

function resolveTargetCardAccountId(
  parsed: FaturaImportItemsJson['suggestions'][number]['parsed'],
  principalCardAccountId: string,
  cards: Array<{ id: string; name: string; parentAccountId: string | null }>,
): string | null {
  if (!parsed.isAdditional) return principalCardAccountId;
  const children = cards.filter((card) => card.parentAccountId === principalCardAccountId);
  if (children.length === 1) return children[0]?.id ?? principalCardAccountId;
  const holderTokens = normalizeAccountLabel(parsed.holderName ?? '')
    .split(' ')
    .filter(Boolean);
  if (holderTokens.length === 0) return null;
  const matches = children.filter((card) => {
    const accountName = normalizeAccountLabel(card.name);
    return holderTokens.some((token) => token.length >= 3 && accountName.includes(token));
  });
  return matches.length === 1 ? (matches[0]?.id ?? null) : null;
}

function normalizeAccountLabel(value: string): string {
  return value
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

async function resolveMissingItem(
  db: DbExecutor,
  userId: string,
  billingMonth: number,
  billingYear: number,
  expected: FaturaImportItemsJson['matchResult']['missingInSystem'][number],
  action: 'keep' | 'remove',
  scheduledService: ScheduledService,
  transactionService: TransactionService,
  removedSchedules: Set<string>,
): Promise<void> {
  if (
    action === 'remove' &&
    expected.scheduleId !== null &&
    removedSchedules.has(expected.scheduleId)
  ) {
    return;
  }

  const [current] = await db
    .select()
    .from(transactions)
    .where(and(eq(transactions.id, expected.transactionId), eq(transactions.userId, userId)))
    .for('update');
  if (
    current === undefined ||
    current.destinationAccountId !== expected.cardAccountId ||
    current.scheduledTransactionId !== expected.scheduleId ||
    current.billingMonth !== billingMonth ||
    current.billingYear !== billingYear ||
    current.domainType !== expected.domainType ||
    current.installmentNumber !== expected.installmentNumber ||
    current.totalInstallments !== expected.totalInstallments ||
    current.date.toISOString().slice(0, 10) !== expected.date ||
    new Decimal(current.amount).abs().toFixed(2) !== expected.amountBRL ||
    current.isReversed
  ) {
    throw new TRPCError({
      code: 'CONFLICT',
      message: 'O item fora da fatura mudou desde a revisão; reimporte antes de aplicar',
    });
  }
  if (action === 'keep') return;
  if (current.isPaid) {
    throw new TRPCError({
      code: 'CONFLICT',
      message: 'Itens já pagos não podem ser removidos pela importação da fatura',
    });
  }

  if (expected.scheduleId === null) {
    await transactionService.reverse(userId, expected.transactionId);
    return;
  }
  if (
    current.domainType !== 'credit_card_expense' &&
    current.domainType !== 'credit_card_installment' &&
    current.domainType !== 'credit_card_fixed_charge' &&
    current.domainType !== 'credit_card_refund'
  ) {
    throw invalidMissingDecision();
  }
  await assertScheduleOnCard(
    db,
    userId,
    expected.scheduleId,
    expected.cardAccountId,
    current.domainType,
  );
  await scheduledService.deleteSchedule(userId, expected.scheduleId);
  removedSchedules.add(expected.scheduleId);
}

async function assertScheduleOnCard(
  db: DbExecutor,
  userId: string,
  scheduleId: string,
  cardAccountId: string,
  domainType:
    | 'credit_card_expense'
    | 'credit_card_installment'
    | 'credit_card_fixed_charge'
    | 'credit_card_refund',
) {
  const [schedule] = await db
    .select()
    .from(scheduledTransactions)
    .where(
      and(
        eq(scheduledTransactions.id, scheduleId),
        eq(scheduledTransactions.userId, userId),
        eq(scheduledTransactions.destinationAccountId, cardAccountId),
        eq(scheduledTransactions.domainType, domainType),
      ),
    )
    .for('update');
  if (schedule === undefined) throw invalidReviewDecision();
  return schedule;
}

async function loadCurrentPaidTotal(
  db: DbExecutor,
  userId: string,
  scheduleId: string,
): Promise<Decimal> {
  const rows = await db
    .select({ amount: transactions.amount, isPaid: transactions.isPaid })
    .from(transactions)
    .where(
      and(
        eq(transactions.userId, userId),
        eq(transactions.scheduledTransactionId, scheduleId),
        eq(transactions.isReversed, false),
      ),
    )
    .for('update');
  return rows.reduce(
    (total, row) => (row.isPaid ? total.plus(new Decimal(row.amount).abs()) : total),
    new Decimal(0),
  );
}

async function updateReviewedExpense(
  db: DbExecutor,
  userId: string,
  cardAccountId: string,
  decision: Extract<ApplyDecision, { kind: 'update_expense' }>,
  domainType: 'credit_card_expense' | 'credit_card_refund' = 'credit_card_expense',
): Promise<void> {
  const [transaction] = await db
    .select()
    .from(transactions)
    .where(
      and(
        eq(transactions.id, decision.transactionId),
        eq(transactions.userId, userId),
        eq(transactions.destinationAccountId, cardAccountId),
        eq(transactions.domainType, domainType),
        eq(transactions.isReversed, false),
      ),
    )
    .for('update');
  if (transaction === undefined || transaction.isPaid) throw invalidReviewDecision();

  if (transaction.scheduledTransactionId !== null) {
    const [schedule] = await db
      .select()
      .from(scheduledTransactions)
      .where(
        and(
          eq(scheduledTransactions.id, transaction.scheduledTransactionId),
          eq(scheduledTransactions.userId, userId),
          eq(scheduledTransactions.destinationAccountId, cardAccountId),
          eq(scheduledTransactions.domainType, domainType),
          eq(scheduledTransactions.frequency, 'once'),
        ),
      );
    if (schedule === undefined) throw invalidReviewDecision();
    await db
      .update(scheduledTransactions)
      .set({
        amount: decision.amount,
        ...(decision.description === undefined ? {} : { description: decision.description }),
        updatedAt: new Date(),
      })
      .where(eq(scheduledTransactions.id, schedule.id));
  }

  await db
    .update(transactions)
    .set({
      amount: decision.amount,
      ...(decision.description === undefined ? {} : { description: decision.description }),
    })
    .where(eq(transactions.id, transaction.id));
}

async function updateReviewedSchedule(
  db: DbExecutor,
  userId: string,
  cardAccountId: string,
  billingMonth: number,
  billingYear: number,
  decision: Extract<ApplyDecision, { kind: 'update_schedule_amount' }>,
  domainType: 'credit_card_fixed_charge' | 'credit_card_refund' = 'credit_card_fixed_charge',
): Promise<void> {
  const schedule = await assertScheduleOnCard(
    db,
    userId,
    decision.scheduleId,
    cardAccountId,
    domainType,
  );
  const [paidCovered] = await db
    .select({ id: transactions.id })
    .from(transactions)
    .where(
      and(
        eq(transactions.userId, userId),
        eq(transactions.scheduledTransactionId, schedule.id),
        eq(transactions.billingMonth, billingMonth),
        eq(transactions.billingYear, billingYear),
        eq(transactions.isPaid, true),
        eq(transactions.isReversed, false),
      ),
    );
  if (paidCovered !== undefined) throw invalidReviewDecision();

  const scope = decision.scope ?? 'cycle';
  const scopeWhere = and(
    eq(transactions.userId, userId),
    eq(transactions.scheduledTransactionId, schedule.id),
    scope === 'cycle'
      ? and(eq(transactions.billingMonth, billingMonth), eq(transactions.billingYear, billingYear))
      : or(
          gt(transactions.billingYear, billingYear),
          and(
            eq(transactions.billingYear, billingYear),
            gte(transactions.billingMonth, billingMonth),
          ),
        ),
  );
  const candidates = await db.select().from(transactions).where(scopeWhere);
  await acquireBillLocks(
    db,
    userId,
    candidates.flatMap((row) =>
      row.billingMonth && row.billingYear
        ? [{ cardAccountId, month: row.billingMonth, year: row.billingYear }]
        : [],
    ),
  );
  const eligible = await db
    .select()
    .from(transactions)
    .where(
      and(
        scopeWhere,
        eq(transactions.isPaid, false),
        eq(transactions.isReversed, false),
        openCardPeriod(),
      ),
    )
    .for('update');
  if (!eligible.some((row) => row.billingMonth === billingMonth && row.billingYear === billingYear))
    throw invalidReviewDecision();
  const changes =
    scope === 'from_cycle'
      ? [
          ...schedule.amountChanges.filter(
            (change) => change.billingMonth !== billingMonth || change.billingYear !== billingYear,
          ),
          { billingMonth, billingYear, amount: decision.amount },
        ].sort((a, b) => a.billingYear * 12 + a.billingMonth - b.billingYear * 12 - b.billingMonth)
      : schedule.amountChanges;
  if (scope === 'from_cycle')
    await db
      .update(scheduledTransactions)
      .set({ amountChanges: changes, updatedAt: new Date() })
      .where(
        and(eq(scheduledTransactions.id, schedule.id), eq(scheduledTransactions.userId, userId)),
      );
  for (const row of eligible) {
    const current = row.billingMonth === billingMonth && row.billingYear === billingYear;
    if (scope === 'from_cycle' && row.isAmountOverridden && !current) continue;
    const amount =
      scope === 'cycle'
        ? decision.amount
        : resolveScheduledAmount(
            schedule.amount,
            changes,
            row.billingMonth && row.billingYear
              ? { billingMonth: row.billingMonth, billingYear: row.billingYear }
              : null,
          );
    await db
      .update(transactions)
      .set({ amount, isAmountOverridden: scope === 'cycle' })
      .where(and(eq(transactions.id, row.id), eq(transactions.userId, userId)));
  }
}
