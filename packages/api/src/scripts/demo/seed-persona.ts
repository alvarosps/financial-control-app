/**
 * Maps the neutral demo dataset (./demo/dataset.ts) onto the real domain
 * for ONE persona, using the SAME flow services the app uses:
 *
 * - categorias → CategoryService
 * - carteiras/cartões → AccountService + CreditCardFlowService.createCreditCard
 * - rendas → IncomeFlowService (income_source_configs + schedules; 13º como
 *   fontes one_time)
 * - contas fixas → ChargeFlowService.createFixed (carteira) ou
 *   CreditCardFlowService.addFixedCharge (cartão)
 * - assinaturas → addFixedCharge no cartão (canceladas ganham endDate +
 *   rematerialize)
 * - compras parceladas → CreditCardFlowService.addInstallment (REGRA do repo:
 *   schedules recorrentes com starting_occurrence=1 e 1ª parcela retro-datada)
 * - financiamento → LoanFlowService.createLoan (parcelas passadas pagas)
 * - empréstimo familiar → FamilyLoanFlowService (installment self-ref +
 *   recordPayment: deposit → conta corrente)
 * - gastos variáveis / eventos pontuais → transações one-time passadas
 *   (avulsas de cartão manuais + cobranças únicas pagas)
 * - passado pago → SettlementService (charges/rendas, com jitter determinístico)
 *   e BillService.payBill (faturas), com a transferência de pagamento
 *   retro-datada para a data real de vencimento da fatura
 *
 * Determinístico: toda aleatoriedade vem de RNGs semeados (ver ./rng.ts).
 */
import type { DbExecutor } from '@fc/db';
import { accounts, transactions } from '@fc/db';
import {
  assignBillingPeriod,
  computeFaturaDueDate,
  getDomainTypesByGroup,
  Money,
} from '@fc/domain';
import { SYSTEM_ACCOUNT_NAMES } from '@fc/shared';
import { and, asc, eq, inArray, lt } from 'drizzle-orm';
import { noOpGuard } from '../../lib/materialization-guard.ts';
import { AccountService } from '../../services/account.service.ts';
import { BillService } from '../../services/bill.service.ts';
import { CategoryService } from '../../services/category.service.ts';
import { ChargeFlowService } from '../../services/charge-flow.service.ts';
import { CreditCardFlowService } from '../../services/credit-card-flow.service.ts';
import { FamilyLoanFlowService } from '../../services/family-loan-flow.service.ts';
import { IncomeFlowService } from '../../services/income-flow.service.ts';
import { LoanFlowService } from '../../services/loan-flow.service.ts';
import { MaterializerService } from '../../services/materializer.service.ts';
import { ScheduledService } from '../../services/scheduled.service.ts';
import { SettlementService } from '../../services/settlement.service.ts';
import { type Dataset, dataset, type FixedCharge, type Income, type Persona } from './dataset.ts';
import { dateAt, isoDateKey, monthAt, startOfDay } from './dates.ts';
import { Rng } from './rng.ts';

const RNG_NAMESPACE = 'fc-demo-v1';
const INCOME_DOMAIN_TYPES = getDomainTypesByGroup('income');

function money(amount: number): string {
  return Money.fromNumber(amount, 'BRL').toDbString();
}

function requireMapped<T>(map: Map<string, T>, key: string, kind: string): T {
  const value = map.get(key);
  if (value === undefined) {
    throw new Error(`demo-seed: ${kind} não mapeado(a): '${key}'`);
  }
  return value;
}

type CardRef = { accountId: string; closingDay: number; dueDay: number };

type PersonaContext = {
  dataset: Dataset;
  db: DbExecutor;
  userId: string;
  persona: Persona;
  now: Date;
  categoryIdByKey: Map<string, string>;
  walletIdByKey: Map<string, string>;
  defaultWalletId: string;
  cardByKey: Map<string, CardRef>;
  cardExpenseAccountId: string;
  /** schedule.id → dataset spec, para jitter/sazonalidade ao marcar como pago. */
  chargeSpecByScheduleId: Map<string, FixedCharge>;
  /** schedule.id → renda irregular (min/max), para variar valores recebidos. */
  irregularIncomeByScheduleId: Map<string, Income>;
};

export async function seedPersonaData(
  db: DbExecutor,
  userId: string,
  persona: Persona,
  now: Date,
  sourceDataset: Dataset = dataset,
): Promise<void> {
  const ctx: PersonaContext = {
    dataset: sourceDataset,
    db,
    userId,
    persona,
    now,
    categoryIdByKey: new Map(),
    walletIdByKey: new Map(),
    defaultWalletId: '',
    cardByKey: new Map(),
    cardExpenseAccountId: '',
    chargeSpecByScheduleId: new Map(),
    irregularIncomeByScheduleId: new Map(),
  };

  await createCategories(ctx);
  await createAccountsAndCards(ctx);
  await createIncomeSources(ctx);
  await createFixedCharges(ctx);
  await createSubscriptions(ctx);
  await createInstallmentPurchases(ctx);
  await createLoans(ctx);
  await createOneOffEvents(ctx);
  await createVariableSpending(ctx);

  console.log('  Materializando schedules (horizonte 12 meses)...');
  await new MaterializerService(db).materializeForUserLocked(userId, 12);

  await settlePastChargeOccurrences(ctx);
  await settlePastIncomeOccurrences(ctx);
  await payPastFaturas(ctx);
  await reanchorWallets(ctx);
}

async function createCategories(ctx: PersonaContext): Promise<void> {
  const categoryService = new CategoryService(ctx.db);
  for (const category of ctx.dataset.categories) {
    const created = await categoryService.create(ctx.userId, {
      name: category.name,
      type: 'expense',
      icon: category.icon,
      color: category.color,
    });
    ctx.categoryIdByKey.set(category.key, created.id);
  }
  console.log(`  Categorias: ${ctx.categoryIdByKey.size}`);
}

async function createAccountsAndCards(ctx: PersonaContext): Promise<void> {
  const accountService = new AccountService(ctx.db);
  const ccFlow = new CreditCardFlowService(ctx.db);

  for (const acct of ctx.persona.accounts) {
    const created = await accountService.create(ctx.userId, {
      name: acct.nickname,
      type: acct.type,
      currency: 'BRL',
    });
    const firstHistoryMonth = Math.min(
      -ctx.persona.historyMonths,
      ...ctx.dataset.loanPlans
        .filter((plan) => plan.personaKey === ctx.persona.key)
        .map((plan) => plan.startMonthsAgo),
    );
    await ctx.db
      .update(accounts)
      .set({ openingBalanceAnchorAt: dateAt(ctx.now, firstHistoryMonth - 1, 1) })
      .where(and(eq(accounts.id, created.id), eq(accounts.userId, ctx.userId)));
    ctx.walletIdByKey.set(acct.key, created.id);
    if (acct.isDefault) {
      await accountService.setDefaultWallet(ctx.userId, created.id);
      ctx.defaultWalletId = created.id;
    }
  }
  if (ctx.defaultWalletId === '') {
    const firstKey = ctx.persona.accounts[0]?.key;
    if (firstKey === undefined) {
      throw new Error(`demo-seed: persona '${ctx.persona.key}' não tem contas`);
    }
    ctx.defaultWalletId = requireMapped(ctx.walletIdByKey, firstKey, 'carteira');
  }

  // Conta de despesa genérica de cartão — mesmo nome de sistema que o QuickAdd
  // do app procura ('Despesas Cartão').
  const cardExpense = await accountService.create(ctx.userId, {
    name: SYSTEM_ACCOUNT_NAMES.CREDIT_CARD_EXPENSES,
    type: 'expense',
    currency: 'BRL',
  });
  ctx.cardExpenseAccountId = cardExpense.id;

  for (const card of ctx.persona.cards) {
    const { account } = await ccFlow.createCreditCard(ctx.userId, {
      name: `${card.nickname} •••• ${card.last4}`,
      closingDay: card.closingDay,
      dueDay: card.dueDay,
      creditLimit: money(card.creditLimit),
    });
    ctx.cardByKey.set(card.key, {
      accountId: account.id,
      closingDay: card.closingDay,
      dueDay: card.dueDay,
    });
  }
  console.log(`  Contas: ${ctx.walletIdByKey.size} carteira(s), ${ctx.cardByKey.size} cartão(ões)`);
}

async function createIncomeSources(ctx: PersonaContext): Promise<void> {
  const incomeFlow = new IncomeFlowService(ctx.db);
  const incomes = ctx.dataset.incomes.filter((i) => i.personaKey === ctx.persona.key);

  for (const income of incomes) {
    // 'irregular' no dataset = recebimento mensal com valor variável; o valor
    // realizado de cada mês passado é ajustado no settlement (min/max via RNG).
    const category = income.frequency === 'monthly' ? 'salary_clt' : 'freelance';
    const result = await incomeFlow.createIncomeSource(ctx.userId, {
      description: income.source,
      amount: money(income.baseAmount),
      frequency: 'monthly',
      category,
      destinationAccountId: ctx.defaultWalletId,
      startDate: dateAt(ctx.now, income.startMonthsAgo, income.day),
      paymentDay: income.day,
    });
    if (income.minAmount != null && income.maxAmount != null) {
      ctx.irregularIncomeByScheduleId.set(result.schedule.id, income);
    }

    // Pagamentos extras (13º salário): fontes one_time nos meses civis do
    // histórico que casam com extra.month.
    for (const extra of income.extraPayments ?? []) {
      for (let offset = income.startMonthsAgo; offset <= 0; offset++) {
        const ym = monthAt(ctx.now, offset);
        if (ym.month !== extra.month) continue;
        await incomeFlow.createIncomeSource(ctx.userId, {
          description: `${extra.label} — ${income.recipientName}`,
          amount: money(extra.amount),
          frequency: 'one_time',
          category: 'salary_clt',
          destinationAccountId: ctx.defaultWalletId,
          startDate: dateAt(ctx.now, offset, 20),
          paymentDay: 20,
        });
      }
    }
  }
  console.log(`  Rendas: ${incomes.length} fonte(s)`);
}

async function createFixedCharges(ctx: PersonaContext): Promise<void> {
  const chargeFlow = new ChargeFlowService(ctx.db);
  const ccFlow = new CreditCardFlowService(ctx.db);
  const charges = ctx.dataset.fixedCharges.filter((c) => c.personaKey === ctx.persona.key);

  for (const charge of charges) {
    const categoryId = requireMapped(ctx.categoryIdByKey, charge.categoryKey, 'categoria');
    const card = ctx.cardByKey.get(charge.paymentMethodKey);
    if (card !== undefined) {
      await ccFlow.addFixedCharge(ctx.userId, {
        creditCardAccountId: card.accountId,
        expenseAccountId: ctx.cardExpenseAccountId,
        description: charge.name,
        amount: money(charge.baseAmount),
        startDate: dateAt(ctx.now, charge.startMonthsAgo, charge.dueDay),
        dueDay: charge.dueDay,
        categoryId,
      });
    } else {
      const wallet = requireMapped(ctx.walletIdByKey, charge.paymentMethodKey, 'carteira');
      const result = await chargeFlow.createFixed(ctx.userId, {
        description: charge.name,
        amount: money(charge.baseAmount),
        sourceAccountId: wallet,
        startDate: dateAt(ctx.now, charge.startMonthsAgo, charge.dueDay),
        dueDay: charge.dueDay,
        categoryId,
      });
      ctx.chargeSpecByScheduleId.set(result.schedule.id, charge);
    }
  }
  console.log(`  Contas fixas: ${charges.length}`);
}

async function createSubscriptions(ctx: PersonaContext): Promise<void> {
  const ccFlow = new CreditCardFlowService(ctx.db);
  const scheduledService = new ScheduledService(ctx.db);
  const materializer = new MaterializerService(ctx.db);
  const categoryId = requireMapped(ctx.categoryIdByKey, 'assinaturas', 'categoria');
  const subs = ctx.dataset.subscriptions.filter((s) => s.personaKey === ctx.persona.key);

  for (const sub of subs) {
    const card = requireMapped(ctx.cardByKey, sub.cardKey, 'cartão');
    const result = await ccFlow.addFixedCharge(ctx.userId, {
      creditCardAccountId: card.accountId,
      expenseAccountId: ctx.cardExpenseAccountId,
      description: `${sub.service} — ${sub.plan}`,
      amount: money(sub.amount),
      startDate: dateAt(ctx.now, sub.startMonthsAgo, sub.billingDay),
      dueDay: sub.billingDay,
      categoryId,
    });
    if (!sub.active && sub.cancelMonthsAgo != null) {
      // Assinatura cancelada: encerra a série no mês do cancelamento e
      // rematerializa (remove ocorrências não pagas além do endDate).
      await scheduledService.update(ctx.userId, result.schedule.id, {
        endDate: dateAt(ctx.now, sub.cancelMonthsAgo, sub.billingDay),
      });
      await materializer.rematerializeForSchedule(ctx.userId, result.schedule.id, 12);
    }
  }
  console.log(`  Assinaturas: ${subs.length}`);
}

async function createInstallmentPurchases(ctx: PersonaContext): Promise<void> {
  const ccFlow = new CreditCardFlowService(ctx.db);
  const purchases = ctx.dataset.installmentPurchases.filter(
    (p) => p.personaKey === ctx.persona.key,
  );

  for (const purchase of purchases) {
    const card = requireMapped(ctx.cardByKey, purchase.cardKey, 'cartão');
    // Posição atual da série em relação ao mês corrente. Séries já encerradas
    // ancoram no mês da ÚLTIMA parcela (normalizeInstallment exige
    // current <= total); o sweep de faturas passadas paga a cauda.
    const monthsElapsed = -purchase.startMonthsAgo;
    const currentNumber = Math.min(purchase.installments, monthsElapsed + 1);
    const currentYm = monthAt(ctx.now, purchase.startMonthsAgo + currentNumber - 1);
    await ccFlow.addInstallment(ctx.userId, {
      creditCardAccountId: card.accountId,
      expenseAccountId: ctx.cardExpenseAccountId,
      description: `${purchase.description} — ${purchase.merchant}`,
      amount: money(purchase.installmentAmount),
      totalInstallments: purchase.installments,
      currentInstallmentNumber: currentNumber,
      currentBillingMonth: currentYm.month,
      currentBillingYear: currentYm.year,
      categoryId: requireMapped(ctx.categoryIdByKey, purchase.categoryKey, 'categoria'),
    });
  }
  console.log(`  Compras parceladas: ${purchases.length}`);
}

async function createLoans(ctx: PersonaContext): Promise<void> {
  const loanFlow = new LoanFlowService(ctx.db);
  const familyFlow = new FamilyLoanFlowService(ctx.db);
  const plans = ctx.dataset.loanPlans.filter((p) => p.personaKey === ctx.persona.key);

  for (const plan of plans) {
    if (plan.loanType === 'financing') {
      await loanFlow.createLoan(ctx.userId, {
        name: plan.description,
        loanCategory: 'bank',
        loanType: 'veiculo',
        monthlyPayment: money(plan.installmentAmount),
        totalInstallments: plan.installments,
        currentInstallment: plan.paidInstallments + 1,
        dueDay: plan.dueDay,
        startDate: dateAt(ctx.now, plan.startMonthsAgo, plan.dueDay),
        checkingAccountId: requireMapped(ctx.walletIdByKey, plan.paymentMethodKey, 'carteira'),
        // O dataset não traz taxa; 1,85% a.m. é típico de CDC de veículos.
        monthlyInterestRate: '1.85',
        payoffCalculationType: 'cdc_veiculos',
        principalAmount: money(plan.principal),
        comment: `${plan.counterparty} — seed demo (${plan.key})`,
      });
    } else {
      // family_loan_granted: config + parcelas OWED (schedule self-ref) +
      // recebimentos reais como family_loan_payment (deposit → conta corrente).
      const { config } = await familyFlow.createFamilyLoan(ctx.userId, {
        personName: plan.counterparty,
        notes: plan.description,
        receiptDay: plan.dueDay,
      });
      const currentInstallment = Math.min(plan.installments, -plan.startMonthsAgo + 1);
      const currentYm = monthAt(ctx.now, 0);
      await familyFlow.addInstallment(ctx.userId, {
        configId: config.id,
        description: plan.description,
        amount: money(plan.installmentAmount),
        totalInstallments: plan.installments,
        currentInstallment,
        dueDay: plan.dueDay,
        billingMonth: currentYm.month,
        billingYear: currentYm.year,
      });
      for (let i = 0; i < plan.paidInstallments; i++) {
        await familyFlow.recordPayment(ctx.userId, {
          configId: config.id,
          amount: money(plan.installmentAmount),
          date: dateAt(ctx.now, plan.startMonthsAgo + i, plan.dueDay),
          walletAccountId: ctx.defaultWalletId,
          notes: `Parcela ${i + 1}/${plan.installments} — ${plan.counterparty}`,
        });
      }
    }
  }
  console.log(`  Empréstimos/financiamentos: ${plans.length}`);
}

async function createOneOffEvents(ctx: PersonaContext): Promise<void> {
  const chargeFlow = new ChargeFlowService(ctx.db);
  const ccFlow = new CreditCardFlowService(ctx.db);
  const incomeFlow = new IncomeFlowService(ctx.db);
  const rng = new Rng(`${RNG_NAMESPACE}:${ctx.persona.key}:events`);
  const events = ctx.dataset.oneOffEvents.filter((e) => e.personaKey === ctx.persona.key);

  for (const event of events) {
    const day = rng.int(2, 26);
    if (event.isIncome === true) {
      // Receita pontual (ex.: reembolso) → fonte one_time; o settlement de
      // rendas passadas marca como recebida.
      await incomeFlow.createIncomeSource(ctx.userId, {
        description: event.description,
        amount: money(event.amount),
        frequency: 'one_time',
        category: 'other',
        destinationAccountId: requireMapped(ctx.walletIdByKey, event.paymentMethodKey, 'carteira'),
        startDate: dateAt(ctx.now, event.monthsAgo, day),
        paymentDay: day,
      });
      continue;
    }

    const categoryId = requireMapped(ctx.categoryIdByKey, event.categoryKey, 'categoria');
    const card = ctx.cardByKey.get(event.paymentMethodKey);
    if (card !== undefined) {
      const purchaseDate = dateAt(ctx.now, event.monthsAgo, day);
      const billing = assignBillingPeriod(purchaseDate, card.closingDay);
      await ccFlow.addOneTimeExpense(ctx.userId, {
        creditCardAccountId: card.accountId,
        expenseAccountId: ctx.cardExpenseAccountId,
        description: event.description,
        amount: money(event.amount),
        billingMonth: billing.billingMonth,
        billingYear: billing.billingYear,
        purchaseDate,
        categoryId,
      });
    } else {
      await chargeFlow.createOneTime(ctx.userId, {
        description: event.description,
        amount: money(event.amount),
        sourceAccountId: requireMapped(ctx.walletIdByKey, event.paymentMethodKey, 'carteira'),
        date: dateAt(ctx.now, event.monthsAgo, day),
        categoryId,
        isPaid: true,
      });
    }
  }
  console.log(`  Eventos pontuais: ${events.length}`);
}

async function createVariableSpending(ctx: PersonaContext): Promise<void> {
  const cardFlow = new CreditCardFlowService(ctx.db);
  const cards = [...ctx.cardByKey.values()];
  if (cards.length === 0) return;

  const merchantByKey = new Map(ctx.dataset.merchants.map((m) => [m.key, m]));
  const categoryNameByKey = new Map(ctx.dataset.categories.map((c) => [c.key, c.name]));
  const rng = new Rng(`${RNG_NAMESPACE}:${ctx.persona.key}:variable`);
  const firstOffset = -(ctx.persona.historyMonths - 1);
  const profiles = ctx.dataset.variableSpending.filter((p) => p.personaKey === ctx.persona.key);

  let inserted = 0;
  for (const profile of profiles) {
    for (let offset = firstOffset; offset <= 0; offset++) {
      const ym = monthAt(ctx.now, offset);
      const seasonal = profile.seasonality.find((s) => s.month === ym.month)?.multiplier ?? 1;
      let total = rng.uniform(profile.minMonthly, profile.maxMonthly) * seasonal;
      // Mês corrente: só o gasto proporcional até hoje.
      if (offset === 0) total *= ctx.now.getDate() / 30;
      if (total < 15) continue;

      const purchaseCount = rng.int(1, Math.min(4, Math.max(1, Math.floor(total / 120))));
      const weights = rng.weights(purchaseCount);
      for (let i = 0; i < purchaseCount; i++) {
        const amount = total * weights[i];
        if (amount < 5) continue;
        const day = offset === 0 ? rng.int(1, Math.max(1, ctx.now.getDate() - 1)) : rng.int(1, 28);
        const purchaseDate = dateAt(ctx.now, offset, day);
        const card = rng.pick(cards);
        const merchant =
          profile.typicalMerchantKeys.length > 0
            ? merchantByKey.get(rng.pick(profile.typicalMerchantKeys))
            : undefined;
        const description =
          merchant?.name ?? `${categoryNameByKey.get(profile.categoryKey) ?? 'Gastos'} — diversos`;
        const billing = assignBillingPeriod(purchaseDate, card.closingDay);
        await cardFlow.addOneTimeExpense(ctx.userId, {
          creditCardAccountId: card.accountId,
          expenseAccountId: ctx.cardExpenseAccountId,
          amount: money(amount),
          description,
          billingMonth: billing.billingMonth,
          billingYear: billing.billingYear,
          purchaseDate,
          categoryId: requireMapped(ctx.categoryIdByKey, profile.categoryKey, 'categoria'),
        });
        inserted++;
      }
    }
    console.log(`  Gastos variáveis: categoria ${profile.categoryKey} (${inserted} compras)`);
  }
  console.log(`  Gastos variáveis: ${inserted} compra(s) avulsa(s) no cartão`);
}

/**
 * Marca como pagas as ocorrências de cobrança (recurring_bill) com data
 * passada, redirecionando a perna da carteira via SettlementService (o mesmo
 * fluxo do botão "marcar como pago"). Cobranças com variância/sazonalidade
 * ganham um valor realizado determinístico (RNG por descrição+data).
 */
async function settlePastChargeOccurrences(ctx: PersonaContext): Promise<void> {
  const settlement = new SettlementService(ctx.db);
  const rows = await ctx.db
    .select()
    .from(transactions)
    .where(
      and(
        eq(transactions.userId, ctx.userId),
        eq(transactions.domainType, 'recurring_bill'),
        eq(transactions.isPaid, false),
        eq(transactions.isReversed, false),
        lt(transactions.date, startOfDay(ctx.now)),
      ),
    )
    .orderBy(asc(transactions.date), asc(transactions.description));

  for (const row of rows) {
    const spec =
      row.scheduledTransactionId !== null
        ? ctx.chargeSpecByScheduleId.get(row.scheduledTransactionId)
        : undefined;
    let amountOverrideBrl: string | undefined;
    if (spec !== undefined && (spec.variancePct > 0 || (spec.seasonalPeaks?.length ?? 0) > 0)) {
      const calendarMonth = row.date.getUTCMonth() + 1;
      const peak = spec.seasonalPeaks?.find((p) => p.month === calendarMonth)?.multiplier ?? 1;
      const rng = new Rng(
        `${RNG_NAMESPACE}:${ctx.persona.key}:charge:${row.description}:${isoDateKey(row.date)}`,
      );
      const jitter = 1 + spec.variancePct * (2 * rng.float() - 1);
      amountOverrideBrl = money(spec.baseAmount * peak * jitter);
    }
    await settlement.settle(ctx.userId, {
      transactionId: row.id,
      walletAccountId: row.sourceAccountId,
      leg: 'source',
      settlementDate: row.date,
      ...(amountOverrideBrl !== undefined && { amountOverrideBrl }),
    });
  }
  console.log(`  Cobranças passadas pagas: ${rows.length}`);
}

/**
 * Marca como recebidas as ocorrências de renda com data passada. Fontes
 * irregulares (min/max no dataset) recebem valor realizado determinístico.
 */
async function settlePastIncomeOccurrences(ctx: PersonaContext): Promise<void> {
  const settlement = new SettlementService(ctx.db);
  const rows = await ctx.db
    .select()
    .from(transactions)
    .where(
      and(
        eq(transactions.userId, ctx.userId),
        inArray(transactions.domainType, INCOME_DOMAIN_TYPES),
        eq(transactions.isPaid, false),
        eq(transactions.isReversed, false),
        lt(transactions.date, startOfDay(ctx.now)),
      ),
    )
    .orderBy(asc(transactions.date), asc(transactions.description));

  for (const row of rows) {
    const spec =
      row.scheduledTransactionId !== null
        ? ctx.irregularIncomeByScheduleId.get(row.scheduledTransactionId)
        : undefined;
    let amountOverrideBrl: string | undefined;
    if (spec?.minAmount != null && spec.maxAmount != null) {
      const rng = new Rng(
        `${RNG_NAMESPACE}:${ctx.persona.key}:income:${row.description}:${isoDateKey(row.date)}`,
      );
      amountOverrideBrl = money(rng.uniform(spec.minAmount, spec.maxAmount));
    }
    await settlement.settle(ctx.userId, {
      transactionId: row.id,
      walletAccountId: row.destinationAccountId,
      leg: 'destination',
      settlementDate: row.date,
      ...(amountOverrideBrl !== undefined && { amountOverrideBrl }),
    });
  }
  console.log(`  Rendas passadas recebidas: ${rows.length}`);
}

/**
 * Paga TODAS as faturas de meses de cobrança anteriores ao mês corrente pelo
 * fluxo canônico BillService.payBill (transfer bill_payment + itens pagos +
 * upsert em credit_card_bills), e depois retro-data a transferência para a
 * data real de vencimento da fatura (computeFaturaDueDate) para a lista de
 * transações contar a história correta.
 */
async function payPastFaturas(ctx: PersonaContext): Promise<void> {
  const billService = new BillService(ctx.db, noOpGuard);
  const firstOffset = Math.min(
    -(ctx.persona.historyMonths + 2),
    ...[
      ...ctx.dataset.fixedCharges,
      ...ctx.dataset.subscriptions,
      ...ctx.dataset.installmentPurchases,
    ]
      .filter((item) => item.personaKey === ctx.persona.key)
      .map((item) => item.startMonthsAgo - 2),
  );
  let paid = 0;

  for (const card of ctx.cardByKey.values()) {
    for (let offset = firstOffset; offset < 0; offset++) {
      const ym = monthAt(ctx.now, offset);
      const bill = await billService.getBill(ctx.userId, card.accountId, ym.month, ym.year);
      if (bill.transactionCount === 0 || bill.isPaid) continue;
      if (bill.unpaidTotalMoney.isZero() || bill.unpaidTotalMoney.isNegative()) continue;

      const dueDate = computeFaturaDueDate(ym.month, ym.year, card.dueDay, card.closingDay);
      if (dueDate > ctx.now) continue;
      await billService.payBill(
        ctx.userId,
        card.accountId,
        ym.month,
        ym.year,
        ctx.defaultWalletId,
        dueDate,
      );
      paid++;
    }
  }
  console.log(`  Faturas passadas pagas: ${paid}`);
}

/**
 * Ancora o saldo real de cada carteira no valor do dataset (modelo Carteiras:
 * opening balance + anchor = caixa canônico ATUAL). Feito por último, para que
 * todo o histórico liquidado acima fique "assado" na âncora e o saldo exibido
 * seja exatamente o do dataset.
 */
async function reanchorWallets(ctx: PersonaContext): Promise<void> {
  const accountService = new AccountService(ctx.db);
  for (const acct of ctx.persona.accounts) {
    if (acct.type !== 'checking') continue;
    const walletId = requireMapped(ctx.walletIdByKey, acct.key, 'carteira');
    await accountService.reanchorWallet(ctx.userId, walletId, money(acct.openingBalance));
  }
  console.log('  Carteiras re-ancoradas nos saldos do dataset');
}
