import {
  accounts,
  auditLog,
  creditCardBills,
  faturaImports,
  faturaMatchRules,
  monthClosings,
  scheduledTransactions,
  transactions,
} from '@fc/db';
import type { ParsedFatura } from '@fc/domain';
import { and, eq } from 'drizzle-orm';
import { PDFDocument } from 'pdf-lib';
import { describe, expect, it } from 'vitest';
import { createTestUser } from '../test/create-test-user.ts';
import { withRollback } from '../test/with-rollback.ts';
import { AccountService } from './account.service.ts';
import { CreditCardFlowService } from './credit-card-flow.service.ts';
import { FaturaImportService } from './fatura-import.service.ts';
import type { FaturaPdfParser } from './fatura-parse/types.ts';
import { MaterializerService } from './materializer.service.ts';
import { PurchaseInboxService } from './purchase-inbox.service.ts';

const NOW = () => new Date(2026, 6, 10);

function fakeParser(fatura: ParsedFatura): FaturaPdfParser {
  return { model: 'fake-model', parse: async () => fatura };
}

function faturaFixture(overrides: Partial<ParsedFatura> = {}): ParsedFatura {
  return {
    dueDate: '2026-07-15',
    statedTotal: '464.31',
    cards: [
      {
        lastFour: '9859',
        holderName: 'ALVARO SOUZA',
        isAdditional: false,
        items: [
          {
            description: 'UBER TRIP',
            amountBRL: '25.90',
            purchaseDate: '2026-06-20',
            installmentCurrent: null,
            installmentTotal: null,
            isRefund: false,
          },
          {
            description: 'MAGAZINELUIZA PARC 03/10',
            amountBRL: '149.99',
            purchaseDate: '2026-04-05',
            installmentCurrent: 3,
            installmentTotal: 10,
            isRefund: false,
          },
        ],
      },
      {
        lastFour: '8516',
        holderName: 'CAMILA STEINMETZ',
        isAdditional: true,
        items: [
          {
            description: 'SEPHORA',
            amountBRL: '288.42',
            purchaseDate: null,
            installmentCurrent: null,
            installmentTotal: null,
            isRefund: false,
          },
        ],
      },
    ],
    ...overrides,
  };
}

function canceledInstallmentFixture(): ParsedFatura {
  return {
    dueDate: '2026-07-15',
    statedTotal: '-207.46',
    cards: [
      {
        lastFour: '9859',
        holderName: 'ALVARO SOUZA',
        isAdditional: false,
        items: [
          ...Array.from({ length: 11 }, (_, index) => ({
            description: 'MERCADOLIVREMERCADOLI',
            amountBRL: '207.37',
            purchaseDate: '2026-05-20',
            installmentCurrent: index + 2,
            installmentTotal: 12,
            isRefund: false,
          })),
          {
            description: 'CREDITO CONCEDIDO',
            amountBRL: '2488.53',
            purchaseDate: '2026-06-30',
            installmentCurrent: null,
            installmentTotal: null,
            isRefund: true,
          },
        ],
      },
    ],
  };
}

function pairedCanceledInstallmentFixture(): ParsedFatura {
  const charges = [1, 2].map((installmentCurrent) => ({
    description: 'MERCADOLIVRE*M',
    amountBRL: '17.50',
    purchaseDate: '2026-06-14',
    installmentCurrent,
    installmentTotal: 2,
    isRefund: false,
  }));
  return {
    dueDate: '2026-07-10',
    statedTotal: '0.00',
    cards: [
      {
        lastFour: '1372',
        holderName: 'ALVARO PEREIRA SILVA',
        isAdditional: false,
        items: [
          ...charges,
          ...charges.map((charge) => ({
            ...charge,
            description: 'CANC PARCELA S',
            isRefund: true,
          })),
        ],
      },
    ],
  };
}

type Tx = Parameters<Parameters<typeof withRollback>[0]>[0];

async function setup(tx: Tx, userId: string) {
  const accounts = new AccountService(tx);
  const expense = await accounts.create(userId, {
    name: 'Despesas',
    type: 'expense',
    currency: 'BRL',
  });
  const flow = new CreditCardFlowService(tx);
  const { account: card } = await flow.createCreditCard(userId, {
    name: 'Cartão teste',
    closingDay: 8,
    dueDay: 15,
  });
  return { expense, card, flow };
}

const pdfDocument = await PDFDocument.create();
pdfDocument.addPage();
const PDF_BASE64 = await pdfDocument.saveAsBase64();

describe('FaturaImportService.createDraft', () => {
  it('preserves matched purchase evidence and reimports an applied document without duplicates', async () => {
    await withRollback(async (tx) => {
      const user = await createTestUser(tx);
      const { expense, card, flow } = await setup(tx, user.id);
      const original = await flow.addOneTimeExpense(user.id, {
        creditCardAccountId: card.id,
        expenseAccountId: expense.id,
        description: 'UBER TRIP',
        amount: '25.90',
        billingMonth: 7,
        billingYear: 2026,
      });
      const fixture = faturaFixture();
      fixture.cards = [fixture.cards[0]];
      fixture.cards[0].items = [fixture.cards[0].items[0]];
      fixture.statedTotal = '25.90';
      const service = new FaturaImportService(tx, { parser: fakeParser(fixture), now: NOW });
      const input = {
        cardAccountId: card.id,
        fileName: 'repeat.pdf',
        pdfBase64: PDF_BASE64,
        externalConsent: true,
      };
      const draft = await service.createDraft(user.id, input);
      const apply = {
        importId: draft.id,
        expenseAccountId: expense.id,
        reviewedPeriod: { month: 7, year: 2026 },
        decisions: [],
      };
      const applied = await service.apply(user.id, apply);
      expect((await service.get(user.id, applied.id)).itemsJson.reconciliation?.status).toBe(
        'reconciled',
      );
      const repeated = await service.createDraft(user.id, input);
      expect(repeated.id).toBe(draft.id);
      await service.apply(user.id, apply);
      const rows = await tx
        .select()
        .from(transactions)
        .where(eq(transactions.destinationAccountId, card.id));
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        id: original.transaction.id,
        date: original.transaction.date,
        purchaseDate: '2026-06-20',
        purchaseDateSource: 'institution',
      });
    });
  });
  it('requires period review and rejects a closed month without writes', async () => {
    await withRollback(async (tx) => {
      const user = await createTestUser(tx);
      const { expense, card } = await setup(tx, user.id);
      const service = new FaturaImportService(tx, {
        parser: fakeParser(faturaFixture()),
        now: NOW,
      });
      const draft = await service.createDraft(user.id, {
        cardAccountId: card.id,
        fileName: 'review.pdf',
        externalConsent: true,
        pdfBase64: PDF_BASE64,
      });
      const input = {
        importId: draft.id,
        expenseAccountId: expense.id,
        decisions: [{ kind: 'skip' as const }],
        acknowledgeTotalMismatch: true,
      };
      await expect(service.apply(user.id, input)).rejects.toThrow('statement.periodReviewRequired');
      await tx
        .insert(monthClosings)
        .values({ userId: user.id, month: 7, year: 2026, status: 'closed' });
      await expect(
        service.apply(user.id, { ...input, reviewedPeriod: { month: 7, year: 2026 } }),
      ).rejects.toThrow('statement.monthClosed');
      expect((await service.get(user.id, draft.id)).status).toBe('draft');
      expect(
        await tx.select().from(transactions).where(eq(transactions.userId, user.id)),
      ).toHaveLength(0);
    });
  });
  it('applies explicitly prospective repricing without changing paid or closed cycles, including after rebuild', async () => {
    await withRollback(async (tx) => {
      const user = await createTestUser(tx);
      const { card, expense, flow } = await setup(tx, user.id);
      const { schedule } = await flow.addFixedCharge(user.id, {
        creditCardAccountId: card.id,
        expenseAccountId: expense.id,
        description: 'Assinatura',
        amount: '10.00',
        startDate: new Date(2026, 4, 1),
        dueDay: 15,
        firstBillingMonth: 5,
        firstBillingYear: 2026,
      });
      await tx
        .update(transactions)
        .set({ isPaid: true, paidAt: new Date('2026-06-15T12:00:00Z') })
        .where(
          and(
            eq(transactions.scheduledTransactionId, schedule.id),
            eq(transactions.billingMonth, 6),
            eq(transactions.billingYear, 2026),
          ),
        );
      await tx
        .insert(monthClosings)
        .values({ userId: user.id, month: 8, year: 2026, status: 'closed', closedAt: NOW() });
      const service = new FaturaImportService(tx, {
        parser: fakeParser({
          dueDate: '2026-07-15',
          statedTotal: '20.00',
          cards: [
            {
              lastFour: null,
              holderName: null,
              isAdditional: false,
              items: [
                {
                  description: 'Assinatura',
                  amountBRL: '20.00',
                  purchaseDate: null,
                  installmentCurrent: null,
                  installmentTotal: null,
                  isRefund: false,
                },
              ],
            },
          ],
        }),
        now: NOW,
      });
      const draft = await service.createDraft(user.id, {
        cardAccountId: card.id,
        fileName: 'preco.pdf',
        externalConsent: true,
        pdfBase64: PDF_BASE64,
      });
      await service.apply(user.id, {
        importId: draft.id,
        expenseAccountId: expense.id,
        reviewedPeriod: { month: 7, year: 2026 },
        decisions: [
          {
            kind: 'update_schedule_amount',
            scheduleId: schedule.id,
            amount: '20.00',
            scope: 'from_cycle',
          },
        ],
      });
      await new MaterializerService(tx).materializeScheduleChanges(user.id, {
        scope: 'targeted',
        fillScheduleIds: [],
        rebuildScheduleIds: [schedule.id],
        horizonMonths: 12,
      });
      const rows = await tx
        .select()
        .from(transactions)
        .where(eq(transactions.scheduledTransactionId, schedule.id));
      const amount = (month: number) =>
        rows.find((row) => row.billingMonth === month && row.billingYear === 2026)?.amount;
      expect([5, 6, 7, 8, 9].map(amount)).toEqual(['10.00', '10.00', '20.00', '10.00', '20.00']);
      const [stored] = await tx
        .select()
        .from(scheduledTransactions)
        .where(eq(scheduledTransactions.id, schedule.id));
      expect(stored?.amount).toBe('10.00');
      expect(stored?.amountChanges).toEqual([
        { billingMonth: 7, billingYear: 2026, amount: '20.00' },
      ]);
    });
  });

  it('parses, matches and stores an auditable draft', async () => {
    await withRollback(async (tx) => {
      const user = await createTestUser(tx);
      const { expense, card, flow } = await setup(tx, user.id);
      await flow.addOneTimeExpense(user.id, {
        creditCardAccountId: card.id,
        expenseAccountId: expense.id,
        description: 'Uber Trip',
        amount: '25.90',
        billingMonth: 7,
        billingYear: 2026,
      });

      const service = new FaturaImportService(tx, {
        parser: fakeParser(faturaFixture()),
        now: NOW,
      });
      const draft = await service.createDraft(user.id, {
        cardAccountId: card.id,
        fileName: 'julho.pdf',
        externalConsent: true,
        pdfBase64: PDF_BASE64,
      });

      expect(draft).toMatchObject({
        status: 'draft',
        billingMonth: 7,
        billingYear: 2026,
        dueDate: '2026-07-15',
        profileId: 'generic',
        parsedTotal: '464.31',
      });
      expect(draft.itemsJson.matchResult.matched).toHaveLength(1);
      expect(draft.itemsJson.matchResult.newOnFatura).toHaveLength(2);
      expect(draft.itemsJson.suggestions.map((item) => item.suggestedKind)).toEqual(
        expect.arrayContaining(['add_installment', 'add_expense']),
      );
    });
  });

  it('accepts a historical statement for review', async () => {
    await withRollback(async (tx) => {
      const user = await createTestUser(tx);
      const { card } = await setup(tx, user.id);
      const service = new FaturaImportService(tx, {
        parser: fakeParser(faturaFixture({ dueDate: '2026-05-10' })),
        now: NOW,
      });
      await expect(
        service.createDraft(user.id, {
          cardAccountId: card.id,
          fileName: 'maio.pdf',
          externalConsent: true,
          pdfBase64: PDF_BASE64,
        }),
      ).resolves.toMatchObject({ billingMonth: 5, billingYear: 2026, dueDate: '2026-05-10' });
    });
  });

  it('assigns an actual August closing to August despite a September due date', async () => {
    await withRollback(async (tx) => {
      const user = await createTestUser(tx);
      const { card } = await setup(tx, user.id);
      const service = new FaturaImportService(tx, {
        parser: fakeParser(faturaFixture({ closingDate: '2026-08-24', dueDate: '2026-09-08' })),
        now: NOW,
      });
      const draft = await service.createDraft(user.id, {
        cardAccountId: card.id,
        fileName: 'agosto.pdf',
        externalConsent: true,
        pdfBase64: PDF_BASE64,
      });
      expect(draft).toMatchObject({
        billingMonth: 8,
        billingYear: 2026,
        closingDate: '2026-08-24',
        dueDate: '2026-09-08',
        closingDateSource: 'institution',
        dueDateSource: 'institution',
        periodConfidence: 'confirmed',
      });
    });
  });

  it('persists document dates on purchases, refunds and the bill without changing installment dates', async () => {
    await withRollback(async (tx) => {
      const user = await createTestUser(tx);
      const { card, expense } = await setup(tx, user.id);
      const service = new FaturaImportService(tx, {
        parser: fakeParser({
          closingDate: '2026-08-24',
          dueDate: '2026-09-08',
          statedTotal: '80.00',
          cards: [
            {
              lastFour: null,
              holderName: null,
              isAdditional: false,
              items: [
                {
                  description: 'Compra',
                  amountBRL: '100.00',
                  purchaseDate: '2026-08-12',
                  postedDate: '2026-08-13',
                  isRefund: false,
                  installmentCurrent: null,
                  installmentTotal: null,
                },
                {
                  description: 'Estorno',
                  amountBRL: '20.00',
                  purchaseDate: '2026-08-14',
                  postedDate: '2026-08-15',
                  isRefund: true,
                  installmentCurrent: null,
                  installmentTotal: null,
                },
              ],
            },
          ],
        }),
        now: NOW,
      });
      const draft = await service.createDraft(user.id, {
        cardAccountId: card.id,
        fileName: 'datas.pdf',
        externalConsent: true,
        pdfBase64: PDF_BASE64,
      });
      await service.apply(user.id, {
        importId: draft.id,
        expenseAccountId: expense.id,
        reviewedPeriod: { month: 8, year: 2026 },
        decisions: [
          {
            kind: 'add_expense',
            suggestionIndex: 0,
            targetCardAccountId: card.id,
            description: 'Compra',
            amount: '100.00',
          },
          {
            kind: 'add_refund',
            suggestionIndex: 1,
            targetCardAccountId: card.id,
            description: 'Estorno',
            amount: '20.00',
          },
        ],
      });
      const rows = await tx
        .select()
        .from(transactions)
        .where(eq(transactions.destinationAccountId, card.id));
      expect(rows.find((row) => row.domainType === 'credit_card_expense')).toMatchObject({
        purchaseDate: '2026-08-12',
        postedDate: '2026-08-13',
        purchaseDateSource: 'institution',
      });
      expect(rows.find((row) => row.domainType === 'credit_card_refund')).toMatchObject({
        purchaseDate: '2026-08-14',
        postedDate: '2026-08-15',
        postedDateSource: 'institution',
      });
      const [bill] = await tx
        .select()
        .from(creditCardBills)
        .where(eq(creditCardBills.creditCardAccountId, card.id));
      expect(bill).toMatchObject({
        month: 8,
        year: 2026,
        closingDate: '2026-08-24',
        dueDate: '2026-09-08',
        closingDateSource: 'institution',
        dueDateSource: 'institution',
      });
    });
  });

  it('rejects oversized, malformed and non-PDF payloads before parsing', async () => {
    await withRollback(async (tx) => {
      const user = await createTestUser(tx);
      const { card } = await setup(tx, user.id);
      const service = new FaturaImportService(tx, {
        parser: fakeParser(faturaFixture()),
        now: NOW,
      });
      const common = { cardAccountId: card.id, fileName: 'bad.pdf' };
      await expect(
        service.createDraft(user.id, {
          ...common,
          externalConsent: true,
          pdfBase64: Buffer.alloc(3 * 1024 * 1024 + 1).toString('base64'),
        }),
      ).rejects.toThrow('statement.pdfTooLarge');
      await expect(
        service.createDraft(user.id, {
          ...common,
          externalConsent: true,
          pdfBase64: 'not@@base64',
        }),
      ).rejects.toThrow('statement.unreadablePdf');
      await expect(
        service.createDraft(user.id, {
          ...common,
          externalConsent: true,
          pdfBase64: Buffer.from('plain text').toString('base64'),
        }),
      ).rejects.toThrow(/PDF/i);
    });
  });

  it('resumes the same document without discarding its draft', async () => {
    await withRollback(async (tx) => {
      const user = await createTestUser(tx);
      const { card } = await setup(tx, user.id);
      const service = new FaturaImportService(tx, {
        parser: fakeParser(faturaFixture()),
        now: NOW,
      });
      const input = {
        cardAccountId: card.id,
        fileName: 'julho.pdf',
        externalConsent: true,
        pdfBase64: PDF_BASE64,
      };
      const first = await service.createDraft(user.id, input);
      const retry = await service.createDraft(user.id, input);
      expect(retry.id).toBe(first.id);
      expect((await service.get(user.id, first.id)).status).toBe('draft');
    });
  });

  it('matches transactions from additional cards in the consolidated statement', async () => {
    await withRollback(async (tx) => {
      const user = await createTestUser(tx);
      const { expense, card, flow } = await setup(tx, user.id);
      const { account: additional } = await flow.createCreditCard(user.id, {
        name: 'Cartão Camila',
        closingDay: 8,
        dueDay: 15,
        parentAccountId: card.id,
      });
      await flow.addOneTimeExpense(user.id, {
        creditCardAccountId: additional.id,
        expenseAccountId: expense.id,
        description: 'Sephora',
        amount: '288.42',
        billingMonth: 7,
        billingYear: 2026,
      });
      const service = new FaturaImportService(tx, {
        parser: fakeParser({
          dueDate: '2026-07-15',
          statedTotal: '288.42',
          cards: [faturaFixture().cards[1] as ParsedFatura['cards'][number]],
        }),
        now: NOW,
      });

      const draft = await service.createDraft(user.id, {
        cardAccountId: card.id,
        fileName: 'adicional.pdf',
        externalConsent: true,
        pdfBase64: PDF_BASE64,
      });

      expect(draft.itemsJson.matchResult.matched[0]?.expected.cardAccountId).toBe(additional.id);
      expect(draft.itemsJson.matchResult.newOnFatura).toHaveLength(0);
    });
  });

  it('matches completed installments from an additional card instead of suggesting duplicates', async () => {
    await withRollback(async (tx) => {
      const user = await createTestUser(tx);
      const { expense, card, flow } = await setup(tx, user.id);
      const { account: additional } = await flow.createCreditCard(user.id, {
        name: 'C6 - Camila',
        closingDay: 3,
        dueDay: 10,
        parentAccountId: card.id,
      });
      for (const item of [
        { description: 'SEPHORA PORTO ALEGRE', amount: '101.16' },
        { description: 'ESPACO MUSE PORTO ALEGRE', amount: '293.33' },
      ]) {
        await flow.addInstallment(user.id, {
          creditCardAccountId: additional.id,
          expenseAccountId: expense.id,
          description: item.description,
          amount: item.amount,
          totalInstallments: 3,
          currentInstallmentNumber: 3,
          currentBillingMonth: 7,
          currentBillingYear: 2026,
        });
      }
      const service = new FaturaImportService(tx, {
        parser: fakeParser({
          dueDate: '2026-07-10',
          statedTotal: '394.49',
          cards: [
            {
              lastFour: '1274',
              holderName: 'CAMILA STEINMETZ',
              isAdditional: true,
              items: [
                {
                  description: 'SEPHORA PORTO ALEGRE',
                  amountBRL: '101.16',
                  purchaseDate: '2026-04-11',
                  installmentCurrent: 3,
                  installmentTotal: 3,
                  isRefund: false,
                },
                {
                  description: 'ESPACO MUSE',
                  amountBRL: '293.33',
                  purchaseDate: '2026-04-22',
                  installmentCurrent: 3,
                  installmentTotal: 3,
                  isRefund: false,
                },
              ],
            },
          ],
        }),
        now: NOW,
      });

      const draft = await service.createDraft(user.id, {
        cardAccountId: card.id,
        fileName: 'c6-adicional.pdf',
        externalConsent: true,
        pdfBase64: PDF_BASE64,
      });

      expect(draft.itemsJson.matchResult.matched).toHaveLength(2);
      expect(draft.itemsJson.matchResult.newOnFatura).toHaveLength(0);
      expect(draft.itemsJson.matchResult.missingInSystem).toHaveLength(0);
      expect(
        draft.itemsJson.matchResult.matched.every(
          ({ expected }) => expected.cardAccountId === additional.id,
        ),
      ).toBe(true);
    });
  });

  it.each([
    'SEPHORA',
    'Outro estabelecimento',
  ])('requires linking an existing item after ambiguous card mapping: %s', async (description) => {
    await withRollback(async (tx) => {
      const user = await createTestUser(tx);
      const { expense, card, flow } = await setup(tx, user.id);
      const additionalIds: string[] = [];
      for (const name of ['Adicional 1', 'Adicional 2']) {
        const { account } = await flow.createCreditCard(user.id, {
          name,
          closingDay: 8,
          dueDay: 15,
          parentAccountId: card.id,
        });
        additionalIds.push(account.id);
        await flow.addOneTimeExpense(user.id, {
          creditCardAccountId: account.id,
          expenseAccountId: expense.id,
          description: 'Sephora',
          amount: '288.42',
          billingMonth: 7,
          billingYear: 2026,
        });
      }
      const service = new FaturaImportService(tx, {
        parser: fakeParser({
          dueDate: '2026-07-15',
          statedTotal: '288.42',
          cards: [
            {
              lastFour: '1234',
              holderName: 'Test Holder',
              isAdditional: true,
              items: [
                {
                  description,
                  amountBRL: '288.42',
                  purchaseDate: null,
                  installmentCurrent: null,
                  installmentTotal: null,
                  isRefund: false,
                },
              ],
            },
          ],
        }),
        now: NOW,
      });

      const draft = await service.createDraft(user.id, {
        cardAccountId: card.id,
        fileName: 'ambiguo.pdf',
        externalConsent: true,
        pdfBase64: PDF_BASE64,
      });

      expect(draft.itemsJson.matchResult.matched).toHaveLength(0);
      expect(draft.itemsJson.matchResult.newOnFatura).toHaveLength(1);
      expect(draft.itemsJson.matchResult.missingInSystem).toHaveLength(2);
      expect(draft.itemsJson.suggestions[0]?.targetCardAccountId).toBeNull();
      await expect(
        service.apply(user.id, {
          importId: draft.id,
          reviewedPeriod: { month: draft.billingMonth, year: draft.billingYear },
          expenseAccountId: expense.id,
          decisions: [
            {
              kind: 'add_expense',
              suggestionIndex: 0,
              targetCardAccountId: additionalIds[0] ?? '',
              description: 'Sephora',
              amount: '288.42',
            },
          ],
        }),
      ).rejects.toThrow(/já corresponde/i);
    });
  });

  it('reviews a uniquely identified installment even when the manual and statement names differ', async () => {
    await withRollback(async (tx) => {
      const user = await createTestUser(tx);
      const { expense, card, flow } = await setup(tx, user.id);
      const { schedule } = await flow.addInstallment(user.id, {
        creditCardAccountId: card.id,
        expenseAccountId: expense.id,
        description: 'Compra 2',
        amount: '216.62',
        totalInstallments: 12,
        currentInstallmentNumber: 2,
        currentBillingMonth: 7,
        currentBillingYear: 2026,
      });
      const service = new FaturaImportService(tx, {
        parser: fakeParser({
          dueDate: '2026-07-15',
          statedTotal: '216.62',
          cards: [
            {
              lastFour: '9859',
              holderName: 'ALVARO SOUZA',
              isAdditional: false,
              items: [
                {
                  description: 'MERCADOLIVRE*RELAXMEDIC',
                  amountBRL: '216.62',
                  purchaseDate: '2026-06-20',
                  installmentCurrent: 2,
                  installmentTotal: 12,
                  isRefund: false,
                },
              ],
            },
          ],
        }),
        now: NOW,
      });

      const draft = await service.createDraft(user.id, {
        cardAccountId: card.id,
        fileName: 'nomes-diferentes.pdf',
        externalConsent: true,
        pdfBase64: PDF_BASE64,
      });

      expect(draft.itemsJson.matchResult.review).toEqual([
        expect.objectContaining({
          expected: expect.objectContaining({ scheduleId: schedule.id, description: 'Compra 2' }),
          parsed: expect.objectContaining({ description: 'MERCADOLIVRE*RELAXMEDIC' }),
          reasons: ['nome_aproximado'],
        }),
      ]);
      expect(draft.itemsJson.matchResult.newOnFatura).toHaveLength(0);
      expect(draft.itemsJson.matchResult.missingInSystem).toHaveLength(0);
    });
  });

  it('reviews unique fixed and one-time charges registered under manual names', async () => {
    await withRollback(async (tx) => {
      const user = await createTestUser(tx);
      const { expense, card, flow } = await setup(tx, user.id);
      await flow.addFixedCharge(user.id, {
        creditCardAccountId: card.id,
        expenseAccountId: expense.id,
        description: 'Globoplay',
        amount: '27.93',
        startDate: new Date(2026, 6, 1),
        dueDay: 15,
        firstBillingMonth: 7,
        firstBillingYear: 2026,
      });
      await flow.addOneTimeExpense(user.id, {
        creditCardAccountId: card.id,
        expenseAccountId: expense.id,
        description: 'Uber 1',
        amount: '16.95',
        billingMonth: 7,
        billingYear: 2026,
        purchaseDate: new Date(2026, 5, 9),
      });
      const service = new FaturaImportService(tx, {
        parser: fakeParser({
          dueDate: '2026-07-15',
          statedTotal: '44.88',
          cards: [
            {
              lastFour: '9859',
              holderName: 'ALVARO SOUZA',
              isAdditional: false,
              items: [
                {
                  description: 'MP *PRODUTOSGLOBO',
                  amountBRL: '27.93',
                  purchaseDate: '2026-06-08',
                  installmentCurrent: null,
                  installmentTotal: null,
                  isRefund: false,
                },
                {
                  description: 'DL *UBERRIDES',
                  amountBRL: '16.95',
                  purchaseDate: '2026-06-06',
                  installmentCurrent: null,
                  installmentTotal: null,
                  isRefund: false,
                },
              ],
            },
          ],
        }),
        now: NOW,
      });

      const draft = await service.createDraft(user.id, {
        cardAccountId: card.id,
        fileName: 'nomes-manuais.pdf',
        externalConsent: true,
        pdfBase64: PDF_BASE64,
      });

      expect([
        ...draft.itemsJson.matchResult.matched,
        ...draft.itemsJson.matchResult.review,
      ]).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            expected: expect.objectContaining({
              description: 'Globoplay',
              domainType: 'credit_card_fixed_charge',
            }),
          }),
          expect.objectContaining({
            expected: expect.objectContaining({
              description: 'Uber 1',
              domainType: 'credit_card_expense',
            }),
          }),
        ]),
      );
      expect(draft.itemsJson.matchResult.newOnFatura).toHaveLength(0);
      expect(draft.itemsJson.matchResult.missingInSystem).toHaveLength(0);
    });
  });

  it('preserves and isolates a canceled installment series with its statement credit', async () => {
    await withRollback(async (tx) => {
      const user = await createTestUser(tx);
      const { expense, card, flow } = await setup(tx, user.id);
      const { schedule } = await flow.addInstallment(user.id, {
        creditCardAccountId: card.id,
        expenseAccountId: expense.id,
        description: 'MERCADOLIVRE*MERCADOLI (207,46)',
        amount: '207.46',
        totalInstallments: 12,
        currentInstallmentNumber: 2,
        currentBillingMonth: 7,
        currentBillingYear: 2026,
      });
      const service = new FaturaImportService(tx, {
        parser: fakeParser(canceledInstallmentFixture()),
        now: NOW,
      });

      const draft = await service.createDraft(user.id, {
        cardAccountId: card.id,
        fileName: 'cancelamento.pdf',
        externalConsent: true,
        pdfBase64: PDF_BASE64,
      });

      expect(draft.itemsJson.reversalBundles).toEqual([
        expect.objectContaining({
          expected: expect.objectContaining({ scheduleId: schedule.id }),
          chargesTotalBRL: '2281.07',
          creditTotalBRL: '2488.53',
          netRefundBRL: '207.46',
        }),
      ]);
      expect(draft.itemsJson.reversalBundles?.[0]?.charges).toHaveLength(11);
      expect(draft.itemsJson.blockedGroups).toHaveLength(0);
      expect(draft.itemsJson.suggestions).toHaveLength(0);
      expect(draft.itemsJson.totals).toMatchObject({
        chargesTotal: '2281.07',
        refundsTotal: '2488.53',
        netTotal: '-207.46',
        delta: '0.00',
      });
    });
  });

  it('isolates a canceled installment series with one credit per installment', async () => {
    await withRollback(async (tx) => {
      const user = await createTestUser(tx);
      const { card } = await setup(tx, user.id);
      const service = new FaturaImportService(tx, {
        parser: fakeParser(pairedCanceledInstallmentFixture()),
        now: NOW,
      });

      const draft = await service.createDraft(user.id, {
        cardAccountId: card.id,
        fileName: 'cancelamento-samsung.pdf',
        externalConsent: true,
        pdfBase64: PDF_BASE64,
      });

      expect(draft.itemsJson.reversalBundles).toEqual([
        expect.objectContaining({
          expected: null,
          refunds: expect.arrayContaining([
            expect.objectContaining({ installmentCurrent: 1, amountBRL: '17.50' }),
            expect.objectContaining({ installmentCurrent: 2, amountBRL: '17.50' }),
          ]),
          chargesTotalBRL: '35.00',
          creditTotalBRL: '35.00',
          netRefundBRL: '0.00',
        }),
      ]);
      expect(draft.itemsJson.blockedGroups).toHaveLength(0);
      expect(draft.itemsJson.suggestions).toHaveLength(0);
      expect(draft.itemsJson.totals).toMatchObject({
        chargesTotal: '35.00',
        refundsTotal: '35.00',
        netTotal: '0.00',
        delta: '0.00',
      });
    });
  });
});

describe('FaturaImportService manual import', () => {
  it('generates the selected profile prompt for an owned card', async () => {
    await withRollback(async (tx) => {
      const user = await createTestUser(tx);
      const { card } = await setup(tx, user.id);
      const service = new FaturaImportService(tx, { now: NOW });

      await expect(service.getManualPrompt(user.id, card.id)).resolves.toMatchObject({
        profileId: 'generic',
        prompt: expect.stringContaining('Retorne somente o objeto JSON'),
      });
    });
  });

  it('creates a manual draft through the same matching pipeline', async () => {
    await withRollback(async (tx) => {
      const user = await createTestUser(tx);
      const { expense, card, flow } = await setup(tx, user.id);
      await flow.addOneTimeExpense(user.id, {
        creditCardAccountId: card.id,
        expenseAccountId: expense.id,
        description: 'Uber Trip',
        amount: '25.90',
        billingMonth: 7,
        billingYear: 2026,
      });
      const service = new FaturaImportService(tx, { now: NOW });

      const draft = await service.createManualDraft(user.id, {
        cardAccountId: card.id,
        provider: 'claude',
        responseJson: JSON.stringify(faturaFixture()),
      });

      expect(draft).toMatchObject({
        fileName: 'manual-response.json',
        modelUsed: 'manual-claude',
        profileId: 'generic',
        billingMonth: 7,
        billingYear: 2026,
      });
      expect(draft.itemsJson.matchResult.matched).toHaveLength(1);
      expect(draft.itemsJson.matchResult.newOnFatura).toHaveLength(2);
    });
  });

  it('rejects invalid JSON and another user card, but allows historical statements', async () => {
    await withRollback(async (tx) => {
      const user = await createTestUser(tx);
      const other = await createTestUser(tx);
      const { card } = await setup(tx, user.id);
      const service = new FaturaImportService(tx, { now: NOW });

      await expect(
        service.createManualDraft(user.id, {
          cardAccountId: card.id,
          provider: 'other',
          responseJson: '{bad json',
        }),
      ).rejects.toThrow(/JSON/i);
      await expect(service.getManualPrompt(other.id, card.id)).rejects.toThrow();
      await expect(
        service.createManualDraft(user.id, {
          cardAccountId: card.id,
          provider: 'chatgpt',
          responseJson: JSON.stringify(faturaFixture({ dueDate: '2026-06-15' })),
        }),
      ).resolves.toMatchObject({ billingMonth: 6, billingYear: 2026 });
    });
  });

  it('builds an ordered trusted manifest and creates independent bulk drafts', async () => {
    await withRollback(async (tx) => {
      const user = await createTestUser(tx);
      const { card: first } = await setup(tx, user.id);
      const { account: second } = await new CreditCardFlowService(tx).createCreditCard(user.id, {
        name: 'Segundo cartão',
        closingDay: 8,
        dueDay: 15,
      });
      const service = new FaturaImportService(tx, { now: NOW });

      const prompt = await service.getBulkManualPrompt(user.id, [second.id, first.id]);
      expect(prompt.manifest).toEqual([
        expect.objectContaining({ reference: 'card-1', cardAccountId: second.id }),
        expect.objectContaining({ reference: 'card-2', cardAccountId: first.id }),
      ]);

      const results = await service.createManualBulkDrafts(user.id, {
        cardAccountIds: [second.id, first.id],
        provider: 'chatgpt',
        responseJson: JSON.stringify({
          statements: [
            { reference: 'card-1', fatura: faturaFixture({ statedTotal: '0.00', cards: [] }) },
            { reference: 'card-2', fatura: faturaFixture({ statedTotal: '0.00', cards: [] }) },
          ],
        }),
      });

      expect(results).toEqual([
        expect.objectContaining({
          reference: 'card-1',
          cardAccountId: second.id,
          importId: expect.any(String),
        }),
        expect.objectContaining({
          reference: 'card-2',
          cardAccountId: first.id,
          importId: expect.any(String),
        }),
      ]);
      const imports = await tx
        .select()
        .from(faturaImports)
        .where(eq(faturaImports.userId, user.id));
      expect(imports.map((item) => item.modelUsed)).toEqual([
        'manual-bulk-chatgpt',
        'manual-bulk-chatgpt',
      ]);
    });
  });

  it('rejects duplicate selections and additional cards from a bulk manifest', async () => {
    await withRollback(async (tx) => {
      const user = await createTestUser(tx);
      const { card: principal, flow } = await setup(tx, user.id);
      const { account: additional } = await flow.createCreditCard(user.id, {
        name: 'Cartão adicional',
        closingDay: 8,
        dueDay: 15,
        parentAccountId: principal.id,
      });
      const service = new FaturaImportService(tx, { now: NOW });

      await expect(
        service.getBulkManualPrompt(user.id, [principal.id, principal.id]),
      ).rejects.toThrow(/repita/i);
      await expect(service.getBulkManualPrompt(user.id, [additional.id])).rejects.toThrow(
        /principais/i,
      );
    });
  });
});

describe('FaturaImportService.apply', () => {
  it('honors an explicit link before checking other identical purchases on a reassigned card', async () => {
    await withRollback(async (tx) => {
      const user = await createTestUser(tx);
      const { expense, card, flow } = await setup(tx, user.id);
      const { account: additional } = await flow.createCreditCard(user.id, {
        name: 'Adicional 1',
        closingDay: 8,
        dueDay: 15,
        parentAccountId: card.id,
      });
      await flow.createCreditCard(user.id, {
        name: 'Adicional 2',
        closingDay: 8,
        dueDay: 15,
        parentAccountId: card.id,
      });
      await flow.addOneTimeExpense(user.id, {
        creditCardAccountId: additional.id,
        expenseAccountId: expense.id,
        description: 'Cinema',
        amount: '50.00',
        billingMonth: 7,
        billingYear: 2026,
      });
      const service = new FaturaImportService(tx, { now: NOW });
      const draft = await service.createManualDraft(user.id, {
        cardAccountId: card.id,
        provider: 'claude',
        responseJson: JSON.stringify({
          dueDate: '2026-07-15',
          statedTotal: '100.00',
          cards: [
            {
              lastFour: '1234',
              holderName: 'Test Holder',
              isAdditional: true,
              items: [3, 4].map((day) => ({
                description: 'Cinema',
                amountBRL: '50.00',
                purchaseDate: `2026-07-0${day}`,
                installmentCurrent: null,
                installmentTotal: null,
                isRefund: false,
              })),
            },
          ],
        }),
      });
      expect(draft.itemsJson.suggestions).toHaveLength(2);
      expect(draft.itemsJson.suggestions.every((item) => item.targetCardAccountId === null)).toBe(
        true,
      );
      const missing = draft.itemsJson.matchResult.missingInSystem[0];
      await service.apply(user.id, {
        importId: draft.id,
        reviewedPeriod: { month: draft.billingMonth, year: draft.billingYear },
        expenseAccountId: expense.id,
        decisions: [
          {
            kind: 'add_expense',
            suggestionIndex: 0,
            targetCardAccountId: additional.id,
            description: 'Cinema',
            amount: '50.00',
          },
          {
            kind: 'link_statement_item',
            suggestionIndex: 1,
            transactionId: missing?.transactionId ?? '',
          },
        ],
      });
      const rows = await tx
        .select()
        .from(transactions)
        .where(
          and(
            eq(transactions.userId, user.id),
            eq(transactions.destinationAccountId, additional.id),
            eq(transactions.billingMonth, 7),
            eq(transactions.billingYear, 2026),
          ),
        );
      expect(rows).toHaveLength(2);
      expect(rows.some((row) => row.id === missing?.transactionId)).toBe(true);
    });
  });

  it.each([
    'keep',
    'remove',
  ] as const)('applies distinct same-value purchases when an unrelated installment is marked %s', async (action) => {
    await withRollback(async (tx) => {
      const user = await createTestUser(tx);
      const { expense, card, flow } = await setup(tx, user.id);
      const { account: additional } = await flow.createCreditCard(user.id, {
        name: 'Cartão adicional',
        closingDay: 8,
        dueDay: 15,
        parentAccountId: card.id,
      });
      const { schedule } = await flow.addInstallment(user.id, {
        creditCardAccountId: additional.id,
        expenseAccountId: expense.id,
        description: 'Anuidade Diferenciada',
        amount: '50.00',
        totalInstallments: 12,
        currentInstallmentNumber: 7,
        currentBillingMonth: 7,
        currentBillingYear: 2026,
      });
      const service = new FaturaImportService(tx, { now: NOW });
      const draft = await service.createManualDraft(user.id, {
        cardAccountId: card.id,
        provider: 'claude',
        responseJson: JSON.stringify({
          dueDate: '2026-07-15',
          statedTotal: '100.00',
          cards: [
            {
              lastFour: '1234',
              holderName: 'Test Holder',
              isAdditional: true,
              items: [3, 4].map((day) => ({
                description: 'HOSPITAL',
                amountBRL: '50.00',
                purchaseDate: `2026-07-0${day}`,
                installmentCurrent: null,
                installmentTotal: null,
                isRefund: false,
              })),
            },
          ],
        }),
      });
      expect(draft.itemsJson.matchResult.matched).toHaveLength(0);
      expect(draft.itemsJson.matchResult.review).toHaveLength(0);
      expect(draft.itemsJson.suggestions).toHaveLength(2);
      expect(draft.itemsJson.matchResult.missingInSystem).toHaveLength(1);
      const missing = draft.itemsJson.matchResult.missingInSystem[0];
      expect(missing?.scheduleId).toBe(schedule.id);

      await service.apply(user.id, {
        importId: draft.id,
        reviewedPeriod: { month: draft.billingMonth, year: draft.billingYear },
        expenseAccountId: expense.id,
        acknowledgeTotalMismatch: action === 'keep',
        decisions: [
          ...draft.itemsJson.suggestions.map((suggestion, suggestionIndex) => ({
            kind: 'add_expense' as const,
            suggestionIndex,
            targetCardAccountId: additional.id,
            description: suggestion.parsed.description,
            amount: suggestion.parsed.amountBRL,
          })),
          { kind: 'resolve_missing_item', transactionId: missing?.transactionId ?? '', action },
        ],
      });

      const rows = await tx
        .select()
        .from(transactions)
        .where(
          and(
            eq(transactions.userId, user.id),
            eq(transactions.destinationAccountId, additional.id),
            eq(transactions.billingMonth, 7),
            eq(transactions.billingYear, 2026),
          ),
        );
      expect(rows).toHaveLength(action === 'keep' ? 3 : 2);
      expect(rows.filter((row) => row.description === 'HOSPITAL')).toHaveLength(2);
      const [updatedSchedule] = await tx
        .select()
        .from(scheduledTransactions)
        .where(eq(scheduledTransactions.id, schedule.id));
      expect(updatedSchedule?.isActive).toBe(action === 'keep');
      const history = await tx
        .select()
        .from(transactions)
        .where(
          and(eq(transactions.scheduledTransactionId, schedule.id), eq(transactions.isPaid, true)),
        );
      expect(history).toHaveLength(6);
      expect((await service.get(user.id, draft.id)).status).toBe('applied');
    });
  });

  it('cancels only unpaid installments and creates a refund for the paid occurrence', async () => {
    await withRollback(async (tx) => {
      const user = await createTestUser(tx);
      const { expense, card, flow } = await setup(tx, user.id);
      const { schedule } = await flow.addInstallment(user.id, {
        creditCardAccountId: card.id,
        expenseAccountId: expense.id,
        description: 'MERCADOLIVRE*MERCADOLI (207,46)',
        amount: '207.46',
        totalInstallments: 12,
        currentInstallmentNumber: 2,
        currentBillingMonth: 7,
        currentBillingYear: 2026,
      });
      const service = new FaturaImportService(tx, {
        parser: fakeParser(canceledInstallmentFixture()),
        now: NOW,
      });
      const draft = await service.createDraft(user.id, {
        cardAccountId: card.id,
        fileName: 'cancelamento.pdf',
        externalConsent: true,
        pdfBase64: PDF_BASE64,
      });

      await service.apply(user.id, {
        importId: draft.id,
        reviewedPeriod: { month: draft.billingMonth, year: draft.billingYear },
        expenseAccountId: expense.id,
        decisions: [{ kind: 'resolve_reversal_bundle', bundleIndex: 0, action: 'apply' }],
      });

      const [persistedSchedule] = await tx
        .select()
        .from(scheduledTransactions)
        .where(eq(scheduledTransactions.id, schedule.id));
      const scheduleTransactions = await tx
        .select()
        .from(transactions)
        .where(eq(transactions.scheduledTransactionId, schedule.id));
      const [refund] = await tx
        .select()
        .from(transactions)
        .where(
          and(
            eq(transactions.userId, user.id),
            eq(transactions.destinationAccountId, card.id),
            eq(transactions.domainType, 'credit_card_refund'),
            eq(transactions.billingMonth, 7),
            eq(transactions.billingYear, 2026),
          ),
        );

      expect(persistedSchedule?.isActive).toBe(false);
      expect(scheduleTransactions).toHaveLength(1);
      expect(scheduleTransactions[0]?.isPaid).toBe(true);
      expect(refund?.amount).toBe('207.46');
      expect(refund?.purchaseDate).toBe('2026-06-30');
      expect(refund?.purchaseDateSource).toBe('institution');
      const purchases = (await new PurchaseInboxService(tx).list(user.id, {})).items;
      expect(purchases).toHaveLength(2);
      expect(purchases.find((item) => item.kind === 'purchase')).toMatchObject({
        confirmation: 'retracted',
        review: 'needs_review',
        appliedAmount: '207.46',
      });
      expect(purchases.find((item) => item.kind === 'refund')).toMatchObject({
        sources: ['pdf'],
        appliedAmount: '207.46',
      });
    });
  });

  it('requires an explicit decision for every item outside the statement and keeps it safely', async () => {
    await withRollback(async (tx) => {
      const user = await createTestUser(tx);
      const { expense, card, flow } = await setup(tx, user.id);
      const { schedule } = await flow.addFixedCharge(user.id, {
        creditCardAccountId: card.id,
        expenseAccountId: expense.id,
        description: 'Globoplay',
        amount: '27.93',
        startDate: new Date(2026, 6, 1),
        dueDay: 15,
        firstBillingMonth: 7,
        firstBillingYear: 2026,
      });
      const service = new FaturaImportService(tx, {
        parser: fakeParser({
          dueDate: '2026-07-15',
          statedTotal: '27.93',
          cards: [
            {
              lastFour: '9859',
              holderName: 'ALVARO SOUZA',
              isAdditional: false,
              items: [],
            },
          ],
        }),
        now: NOW,
      });
      const draft = await service.createDraft(user.id, {
        cardAccountId: card.id,
        fileName: 'incompleta.pdf',
        externalConsent: true,
        pdfBase64: PDF_BASE64,
      });
      const missing = draft.itemsJson.matchResult.missingInSystem[0];
      expect(missing).toMatchObject({
        description: 'Globoplay',
        domainType: 'credit_card_fixed_charge',
        installmentNumber: null,
        totalInstallments: null,
        isPaid: false,
      });

      await expect(
        service.apply(user.id, {
          importId: draft.id,
          reviewedPeriod: { month: draft.billingMonth, year: draft.billingYear },
          expenseAccountId: expense.id,
          decisions: [],
        }),
      ).rejects.toThrow(/fora da fatura/i);

      await service.apply(user.id, {
        importId: draft.id,
        reviewedPeriod: { month: draft.billingMonth, year: draft.billingYear },
        expenseAccountId: expense.id,
        decisions: [
          {
            kind: 'resolve_missing_item',
            transactionId: missing?.transactionId ?? '',
            action: 'keep',
          },
        ],
      });

      const [persistedSchedule] = await tx
        .select()
        .from(scheduledTransactions)
        .where(eq(scheduledTransactions.id, schedule.id));
      expect(persistedSchedule?.isActive).toBe(true);
    });
  });

  it('links a statement item to a fixed charge, corrects only this cycle and learns the merchant', async () => {
    await withRollback(async (tx) => {
      const user = await createTestUser(tx);
      const { expense, card, flow } = await setup(tx, user.id);
      const { schedule } = await flow.addFixedCharge(user.id, {
        creditCardAccountId: card.id,
        expenseAccountId: expense.id,
        description: 'claude max',
        amount: '1162.79',
        startDate: new Date(2026, 6, 1),
        dueDay: 15,
        firstBillingMonth: 7,
        firstBillingYear: 2026,
      });
      const statement: ParsedFatura = {
        dueDate: '2026-07-15',
        statedTotal: '1183.35',
        cards: [
          {
            lastFour: '9859',
            holderName: 'ALVARO SOUZA',
            isAdditional: false,
            items: [
              {
                description: 'ANTHROPIC* CLAUDE SUB',
                amountBRL: '1183.35',
                purchaseDate: '2026-07-05',
                installmentCurrent: null,
                installmentTotal: null,
                isRefund: false,
              },
            ],
          },
        ],
      };
      const service = new FaturaImportService(tx, {
        parser: fakeParser(statement),
        now: NOW,
      });
      const draft = await service.createDraft(user.id, {
        cardAccountId: card.id,
        fileName: 'claude.pdf',
        externalConsent: true,
        pdfBase64: PDF_BASE64,
      });
      const missing = draft.itemsJson.matchResult.missingInSystem[0];
      expect(draft.itemsJson.suggestions).toHaveLength(1);
      expect(missing?.scheduleId).toBe(schedule.id);

      await service.apply(user.id, {
        importId: draft.id,
        reviewedPeriod: { month: draft.billingMonth, year: draft.billingYear },
        expenseAccountId: expense.id,
        decisions: [
          {
            kind: 'link_statement_item',
            suggestionIndex: 0,
            transactionId: missing?.transactionId ?? '',
          },
        ],
      });

      const [updatedSchedule] = await tx
        .select()
        .from(scheduledTransactions)
        .where(eq(scheduledTransactions.id, schedule.id));
      const openOccurrences = await tx
        .select()
        .from(transactions)
        .where(
          and(eq(transactions.scheduledTransactionId, schedule.id), eq(transactions.isPaid, false)),
        );
      const [learnedRule] = await tx
        .select()
        .from(faturaMatchRules)
        .where(eq(faturaMatchRules.targetScheduleId, schedule.id));
      expect(updatedSchedule?.amount).toBe('1162.79');
      expect(
        openOccurrences.find((row) => row.billingMonth === 7 && row.billingYear === 2026)?.amount,
      ).toBe('1183.35');
      expect(
        openOccurrences.find((row) => row.billingMonth === 8 && row.billingYear === 2026)?.amount,
      ).toBe('1162.79');
      await new MaterializerService(tx).materializeScheduleChanges(user.id, {
        scope: 'targeted',
        fillScheduleIds: [],
        rebuildScheduleIds: [schedule.id],
        horizonMonths: 12,
      });
      const [preserved] = await tx
        .select()
        .from(transactions)
        .where(eq(transactions.id, missing?.transactionId ?? ''));
      expect(preserved?.amount).toBe('1183.35');
      expect(learnedRule?.rawNormalized).toBe('anthropic claude sub');

      const nextStatement = structuredClone(statement);
      nextStatement.statedTotal = '1190.00';
      const nextItem = nextStatement.cards[0]?.items[0];
      if (nextItem !== undefined) nextItem.amountBRL = '1190.00';
      const nextService = new FaturaImportService(tx, {
        parser: fakeParser(nextStatement),
        now: NOW,
      });
      const nextDraft = await nextService.createDraft(user.id, {
        cardAccountId: card.id,
        fileName: 'claude-again.pdf',
        externalConsent: true,
        pdfBase64: Buffer.concat([Buffer.from(PDF_BASE64, 'base64'), Buffer.from('\n')]).toString(
          'base64',
        ),
      });
      expect(nextDraft.itemsJson.matchResult.review[0]).toMatchObject({
        expected: { scheduleId: schedule.id },
        parsed: { description: 'ANTHROPIC* CLAUDE SUB' },
      });
      expect(nextDraft.itemsJson.suggestions).toHaveLength(0);
    });
  });

  it('rejects linking the same statement item to more than one expected item', async () => {
    await withRollback(async (tx) => {
      const user = await createTestUser(tx);
      const { expense, card, flow } = await setup(tx, user.id);
      for (const description of ['Assinatura A', 'Assinatura B']) {
        await flow.addFixedCharge(user.id, {
          creditCardAccountId: card.id,
          expenseAccountId: expense.id,
          description,
          amount: '44.90',
          startDate: new Date(2026, 6, 1),
          dueDay: 15,
          firstBillingMonth: 7,
          firstBillingYear: 2026,
        });
      }
      const service = new FaturaImportService(tx, {
        parser: fakeParser({
          dueDate: '2026-07-15',
          statedTotal: '43.79',
          cards: [
            {
              lastFour: '9859',
              holderName: 'ALVARO SOUZA',
              isAdditional: false,
              items: [
                {
                  description: 'OCULUS *FWHX6WHAY2',
                  amountBRL: '43.79',
                  purchaseDate: '2026-07-05',
                  installmentCurrent: null,
                  installmentTotal: null,
                  isRefund: false,
                },
              ],
            },
          ],
        }),
        now: NOW,
      });
      const draft = await service.createDraft(user.id, {
        cardAccountId: card.id,
        fileName: 'meta.pdf',
        externalConsent: true,
        pdfBase64: PDF_BASE64,
      });
      const missing = draft.itemsJson.matchResult.missingInSystem;

      await expect(
        service.apply(user.id, {
          importId: draft.id,
          reviewedPeriod: { month: draft.billingMonth, year: draft.billingYear },
          expenseAccountId: expense.id,
          decisions: missing.map((item) => ({
            kind: 'link_statement_item' as const,
            suggestionIndex: 0,
            transactionId: item.transactionId,
          })),
          acknowledgeTotalMismatch: true,
        }),
      ).rejects.toThrow(/fora da fatura/i);
      expect((await service.get(user.id, draft.id)).status).toBe('draft');
    });
  });

  it('rejects keeping an outside item that changed after review', async () => {
    await withRollback(async (tx) => {
      const user = await createTestUser(tx);
      const { expense, card, flow } = await setup(tx, user.id);
      await flow.addFixedCharge(user.id, {
        creditCardAccountId: card.id,
        expenseAccountId: expense.id,
        description: 'Globoplay',
        amount: '27.93',
        startDate: new Date(2026, 6, 1),
        dueDay: 15,
        firstBillingMonth: 7,
        firstBillingYear: 2026,
      });
      const service = new FaturaImportService(tx, {
        parser: fakeParser({
          dueDate: '2026-07-15',
          statedTotal: '27.93',
          cards: [
            {
              lastFour: '9859',
              holderName: 'ALVARO SOUZA',
              isAdditional: false,
              items: [],
            },
          ],
        }),
        now: NOW,
      });
      const draft = await service.createDraft(user.id, {
        cardAccountId: card.id,
        fileName: 'alterada-depois.pdf',
        externalConsent: true,
        pdfBase64: PDF_BASE64,
      });
      const missing = draft.itemsJson.matchResult.missingInSystem[0];
      await tx
        .update(transactions)
        .set({ amount: '29.90' })
        .where(eq(transactions.id, missing?.transactionId ?? ''));

      await expect(
        service.apply(user.id, {
          importId: draft.id,
          reviewedPeriod: { month: draft.billingMonth, year: draft.billingYear },
          expenseAccountId: expense.id,
          decisions: [
            {
              kind: 'resolve_missing_item',
              transactionId: missing?.transactionId ?? '',
              action: 'keep',
            },
          ],
        }),
      ).rejects.toThrow('statement.staleDraft');
      expect((await service.get(user.id, draft.id)).status).toBe('draft');
    });
  });

  it('removes an absent installment series while preserving paid history', async () => {
    await withRollback(async (tx) => {
      const user = await createTestUser(tx);
      const { expense, card, flow } = await setup(tx, user.id);
      const { schedule } = await flow.addInstallment(user.id, {
        creditCardAccountId: card.id,
        expenseAccountId: expense.id,
        description: 'Compra incorreta',
        amount: '88.37',
        totalInstallments: 12,
        currentInstallmentNumber: 2,
        currentBillingMonth: 7,
        currentBillingYear: 2026,
      });
      const service = new FaturaImportService(tx, {
        parser: fakeParser({
          dueDate: '2026-07-15',
          statedTotal: '0.00',
          cards: [
            {
              lastFour: '9859',
              holderName: 'ALVARO SOUZA',
              isAdditional: false,
              items: [],
            },
          ],
        }),
        now: NOW,
      });
      const draft = await service.createDraft(user.id, {
        cardAccountId: card.id,
        fileName: 'sem-parcela.pdf',
        externalConsent: true,
        pdfBase64: PDF_BASE64,
      });
      const missing = draft.itemsJson.matchResult.missingInSystem[0];
      expect(missing).toMatchObject({
        scheduleId: schedule.id,
        installmentNumber: 2,
        totalInstallments: 12,
      });

      await service.apply(user.id, {
        importId: draft.id,
        reviewedPeriod: { month: draft.billingMonth, year: draft.billingYear },
        expenseAccountId: expense.id,
        decisions: [
          {
            kind: 'resolve_missing_item',
            transactionId: missing?.transactionId ?? '',
            action: 'remove',
          },
        ],
      });

      const [persistedSchedule] = await tx
        .select()
        .from(scheduledTransactions)
        .where(eq(scheduledTransactions.id, schedule.id));
      const remaining = await tx
        .select()
        .from(transactions)
        .where(eq(transactions.scheduledTransactionId, schedule.id));
      expect(persistedSchedule?.isActive).toBe(false);
      expect(remaining).toHaveLength(1);
      expect(remaining[0]).toMatchObject({ installmentNumber: 1, isPaid: true });
    });
  });

  it('reverses an absent one-time purchase without touching schedules', async () => {
    await withRollback(async (tx) => {
      const user = await createTestUser(tx);
      const { expense, card, flow } = await setup(tx, user.id);
      const { transaction } = await flow.addOneTimeExpense(user.id, {
        creditCardAccountId: card.id,
        expenseAccountId: expense.id,
        description: 'Uber 1',
        amount: '16.95',
        billingMonth: 7,
        billingYear: 2026,
        purchaseDate: new Date(2026, 5, 9),
      });
      const service = new FaturaImportService(tx, {
        parser: fakeParser({
          dueDate: '2026-07-15',
          statedTotal: '0.00',
          cards: [
            {
              lastFour: '9859',
              holderName: 'ALVARO SOUZA',
              isAdditional: false,
              items: [],
            },
          ],
        }),
        now: NOW,
      });
      const draft = await service.createDraft(user.id, {
        cardAccountId: card.id,
        fileName: 'sem-compra-avulsa.pdf',
        externalConsent: true,
        pdfBase64: PDF_BASE64,
      });
      const missing = draft.itemsJson.matchResult.missingInSystem[0];
      expect(missing).toMatchObject({
        transactionId: transaction.id,
        scheduleId: null,
        domainType: 'credit_card_expense',
      });

      await service.apply(user.id, {
        importId: draft.id,
        reviewedPeriod: { month: draft.billingMonth, year: draft.billingYear },
        expenseAccountId: expense.id,
        decisions: [
          {
            kind: 'resolve_missing_item',
            transactionId: missing?.transactionId ?? '',
            action: 'remove',
          },
        ],
      });

      const remaining = await tx
        .select()
        .from(transactions)
        .where(eq(transactions.id, transaction.id));
      expect(remaining[0]).toMatchObject({ isReversed: true });
    });
  });

  it('removes an absent scheduled refund without rejecting its domain type', async () => {
    await withRollback(async (tx) => {
      const user = await createTestUser(tx);
      const { expense, card, flow } = await setup(tx, user.id);
      const { schedule } = await flow.addFixedCharge(user.id, {
        creditCardAccountId: card.id,
        expenseAccountId: expense.id,
        description: 'Estorno Anuidade Diferenciada',
        amount: '105.00',
        startDate: new Date(2026, 6, 1),
        dueDay: 15,
        firstBillingMonth: 7,
        firstBillingYear: 2026,
      });
      await tx
        .update(scheduledTransactions)
        .set({ domainType: 'credit_card_refund', isFixedCharge: false })
        .where(eq(scheduledTransactions.id, schedule.id));
      await tx
        .update(transactions)
        .set({ domainType: 'credit_card_refund' })
        .where(eq(transactions.scheduledTransactionId, schedule.id));

      const service = new FaturaImportService(tx, {
        parser: fakeParser({
          dueDate: '2026-07-15',
          statedTotal: '0.00',
          cards: [
            {
              lastFour: '9859',
              holderName: 'ALVARO SOUZA',
              isAdditional: false,
              items: [],
            },
          ],
        }),
        now: NOW,
      });
      const draft = await service.createDraft(user.id, {
        cardAccountId: card.id,
        fileName: 'sem-estorno.pdf',
        externalConsent: true,
        pdfBase64: PDF_BASE64,
      });
      const missing = draft.itemsJson.matchResult.missingInSystem[0];
      expect(missing?.domainType).toBe('credit_card_refund');

      await service.apply(user.id, {
        importId: draft.id,
        reviewedPeriod: { month: draft.billingMonth, year: draft.billingYear },
        expenseAccountId: expense.id,
        decisions: [
          {
            kind: 'resolve_missing_item',
            transactionId: missing?.transactionId ?? '',
            action: 'remove',
          },
        ],
      });

      const [persistedSchedule] = await tx
        .select()
        .from(scheduledTransactions)
        .where(eq(scheduledTransactions.id, schedule.id));
      expect(persistedSchedule?.isActive).toBe(false);
    });
  });

  it.each([
    'one-time',
    'cycle',
    'from_cycle',
  ] as const)('accepts a reviewed refund amount with %s scope', async (scope) => {
    await withRollback(async (tx) => {
      const user = await createTestUser(tx);
      const { expense, card, flow } = await setup(tx, user.id);
      let scheduleId: string | null = null;
      if (scope === 'one-time') {
        await flow.addRefund(user.id, {
          creditCardAccountId: card.id,
          expenseAccountId: expense.id,
          description: 'Estorno Anuidade',
          amount: '105.00',
          billingMonth: 7,
          billingYear: 2026,
        });
      } else {
        const { schedule } = await flow.addFixedCharge(user.id, {
          creditCardAccountId: card.id,
          expenseAccountId: expense.id,
          description: 'Estorno Anuidade',
          amount: '105.00',
          startDate: new Date(2026, 6, 1),
          dueDay: 15,
          firstBillingMonth: 7,
          firstBillingYear: 2026,
        });
        scheduleId = schedule.id;
        await tx
          .update(scheduledTransactions)
          .set({ domainType: 'credit_card_refund', isFixedCharge: false })
          .where(eq(scheduledTransactions.id, schedule.id));
        await tx
          .update(transactions)
          .set({ domainType: 'credit_card_refund' })
          .where(eq(transactions.scheduledTransactionId, schedule.id));
      }
      const service = new FaturaImportService(tx, {
        parser: fakeParser(
          faturaFixture({
            statedTotal: '-105.15',
            cards: [
              {
                lastFour: null,
                holderName: null,
                isAdditional: false,
                items: [
                  {
                    description: 'ESTORNO ANUIDADE',
                    amountBRL: '105.15',
                    purchaseDate: '2026-07-05',
                    postedDate: '2026-07-06',
                    installmentCurrent: null,
                    installmentTotal: null,
                    isRefund: true,
                  },
                ],
              },
            ],
          }),
        ),
        now: NOW,
      });
      const draft = await service.createDraft(user.id, {
        cardAccountId: card.id,
        fileName: 'reviewed-refund.pdf',
        externalConsent: true,
        pdfBase64: PDF_BASE64,
      });
      expect(draft.itemsJson.matchResult.review).toHaveLength(1);
      const expected = draft.itemsJson.matchResult.review[0]?.expected;
      expect(expected).toMatchObject({ domainType: 'credit_card_refund', scheduleId });
      const result = await service.apply(user.id, {
        importId: draft.id,
        reviewedPeriod: { month: 7, year: 2026 },
        expenseAccountId: expense.id,
        decisions:
          scope === 'one-time'
            ? [
                {
                  kind: 'update_expense',
                  transactionId: expected?.transactionId ?? '',
                  amount: '105.15',
                },
              ]
            : [
                {
                  kind: 'update_schedule_amount',
                  scheduleId: scheduleId ?? '',
                  amount: '105.15',
                  scope,
                },
              ],
      });
      expect(result).toMatchObject({ status: 'applied', reconciliation: { status: 'reconciled' } });
      if (scheduleId !== null) {
        await new MaterializerService(tx).materializeScheduleChanges(user.id, {
          scope: 'targeted',
          fillScheduleIds: [],
          rebuildScheduleIds: [scheduleId],
          horizonMonths: 12,
        });
        const [stored] = await tx
          .select()
          .from(scheduledTransactions)
          .where(eq(scheduledTransactions.id, scheduleId));
        expect(stored?.amount).toBe('105.00');
        expect(stored?.amountChanges).toEqual(
          scope === 'from_cycle' ? [{ billingMonth: 7, billingYear: 2026, amount: '105.15' }] : [],
        );
      }
      const rows = await tx
        .select()
        .from(transactions)
        .where(
          and(eq(transactions.userId, user.id), eq(transactions.domainType, 'credit_card_refund')),
        );
      expect(rows.filter((row) => row.billingMonth === 7 && row.billingYear === 2026)).toEqual([
        expect.objectContaining({
          amount: '105.15',
          purchaseDate: '2026-07-05',
          purchaseDateSource: 'institution',
          postedDate: '2026-07-06',
          postedDateSource: 'institution',
        }),
      ]);
      if (scope === 'one-time') {
        expect(rows).toHaveLength(1);
      } else {
        expect(rows.find((row) => row.billingMonth === 8 && row.billingYear === 2026)?.amount).toBe(
          scope === 'from_cycle' ? '105.15' : '105.00',
        );
        expect(
          rows.find((row) => row.billingMonth === 8 && row.billingYear === 2026),
        ).toMatchObject({
          purchaseDate: null,
          postedDate: null,
        });
      }
    });
  });

  it('links a statement refund to an existing scheduled refund and learns its alias', async () => {
    await withRollback(async (tx) => {
      const user = await createTestUser(tx);
      const { expense, card, flow } = await setup(tx, user.id);
      const { schedule } = await flow.addFixedCharge(user.id, {
        creditCardAccountId: card.id,
        expenseAccountId: expense.id,
        description: 'Estorno Anuidade Diferenciada',
        amount: '105.00',
        startDate: new Date(2026, 6, 1),
        dueDay: 15,
        firstBillingMonth: 7,
        firstBillingYear: 2026,
      });
      await tx
        .update(scheduledTransactions)
        .set({ domainType: 'credit_card_refund', isFixedCharge: false })
        .where(eq(scheduledTransactions.id, schedule.id));
      await tx
        .update(transactions)
        .set({ domainType: 'credit_card_refund' })
        .where(eq(transactions.scheduledTransactionId, schedule.id));

      const service = new FaturaImportService(tx, {
        parser: fakeParser({
          dueDate: '2026-07-15',
          statedTotal: '-52.50',
          cards: [
            {
              lastFour: '9859',
              holderName: 'ALVARO SOUZA',
              isAdditional: false,
              items: [
                {
                  description: 'ESTORNO DE ANUIDADE DIF',
                  amountBRL: '52.50',
                  purchaseDate: '2026-07-05',
                  installmentCurrent: null,
                  installmentTotal: null,
                  isRefund: true,
                },
              ],
            },
          ],
        }),
        now: NOW,
      });
      const draft = await service.createDraft(user.id, {
        cardAccountId: card.id,
        fileName: 'estorno-anuidade.pdf',
        externalConsent: true,
        pdfBase64: PDF_BASE64,
      });
      const missing = draft.itemsJson.matchResult.missingInSystem[0];
      expect(draft.itemsJson.suggestions).toHaveLength(1);
      expect(missing).toMatchObject({
        scheduleId: schedule.id,
        domainType: 'credit_card_refund',
      });

      await service.apply(user.id, {
        importId: draft.id,
        reviewedPeriod: { month: draft.billingMonth, year: draft.billingYear },
        expenseAccountId: expense.id,
        decisions: [
          {
            kind: 'link_statement_item',
            suggestionIndex: 0,
            transactionId: missing?.transactionId ?? '',
          },
        ],
      });

      const [updatedSchedule] = await tx
        .select()
        .from(scheduledTransactions)
        .where(eq(scheduledTransactions.id, schedule.id));
      const openOccurrences = await tx
        .select()
        .from(transactions)
        .where(
          and(eq(transactions.scheduledTransactionId, schedule.id), eq(transactions.isPaid, false)),
        );
      const [learnedRule] = await tx
        .select()
        .from(faturaMatchRules)
        .where(eq(faturaMatchRules.targetScheduleId, schedule.id));
      expect(updatedSchedule?.amount).toBe('105.00');
      expect(
        openOccurrences.find((row) => row.billingMonth === 7 && row.billingYear === 2026)?.amount,
      ).toBe('52.50');
      expect(
        openOccurrences.find((row) => row.billingMonth === 8 && row.billingYear === 2026)?.amount,
      ).toBe('105.00');
      expect(learnedRule?.rawNormalized).toBe('estorno de anuidade dif');
    });
  });

  it('rejects removing an item that was paid after the draft was created', async () => {
    await withRollback(async (tx) => {
      const user = await createTestUser(tx);
      const { expense, card, flow } = await setup(tx, user.id);
      await flow.addOneTimeExpense(user.id, {
        creditCardAccountId: card.id,
        expenseAccountId: expense.id,
        description: 'Compra avulsa',
        amount: '30.00',
        billingMonth: 7,
        billingYear: 2026,
      });
      const service = new FaturaImportService(tx, {
        parser: fakeParser({
          dueDate: '2026-07-15',
          statedTotal: '0.00',
          cards: [
            {
              lastFour: '9859',
              holderName: 'ALVARO SOUZA',
              isAdditional: false,
              items: [],
            },
          ],
        }),
        now: NOW,
      });
      const draft = await service.createDraft(user.id, {
        cardAccountId: card.id,
        fileName: 'pago-depois.pdf',
        externalConsent: true,
        pdfBase64: PDF_BASE64,
      });
      const missing = draft.itemsJson.matchResult.missingInSystem[0];
      await tx
        .update(transactions)
        .set({ isPaid: true, paidAt: NOW() })
        .where(eq(transactions.id, missing?.transactionId ?? ''));

      await expect(
        service.apply(user.id, {
          importId: draft.id,
          reviewedPeriod: { month: draft.billingMonth, year: draft.billingYear },
          expenseAccountId: expense.id,
          decisions: [
            {
              kind: 'resolve_missing_item',
              transactionId: missing?.transactionId ?? '',
              action: 'remove',
            },
          ],
        }),
      ).rejects.toThrow('statement.staleDraft');
      expect((await service.get(user.id, draft.id)).status).toBe('draft');
    });
  });

  it('applies new expense, installment, subscription and refund atomically', async () => {
    await withRollback(async (tx) => {
      const user = await createTestUser(tx);
      const { expense, card } = await setup(tx, user.id);
      const fixture = faturaFixture();
      fixture.cards[1]?.items.push({
        description: 'ESTORNO',
        amountBRL: '50.00',
        purchaseDate: null,
        installmentCurrent: null,
        installmentTotal: null,
        isRefund: true,
      });
      const service = new FaturaImportService(tx, {
        parser: fakeParser(fixture),
        now: NOW,
      });
      const draft = await service.createDraft(user.id, {
        cardAccountId: card.id,
        fileName: 'julho.pdf',
        externalConsent: true,
        pdfBase64: PDF_BASE64,
      });

      await expect(
        service.apply(user.id, {
          importId: draft.id,
          reviewedPeriod: { month: draft.billingMonth, year: draft.billingYear },
          expenseAccountId: expense.id,
          decisions: [
            {
              kind: 'add_expense',
              suggestionIndex: 0,
              targetCardAccountId: card.id,
              description: 'Uber Trip',
              amount: '25.90',
            },
            {
              kind: 'add_installment',
              suggestionIndex: 1,
              targetCardAccountId: card.id,
              description: 'Magazine Luiza',
              amount: '149.99',
              totalInstallments: 10,
              currentInstallmentNumber: 3,
            },
            {
              kind: 'add_fixed_charge',
              suggestionIndex: 2,
              targetCardAccountId: card.id,
              description: 'Sephora',
              amount: '288.42',
            },
            {
              kind: 'add_refund',
              suggestionIndex: 3,
              targetCardAccountId: card.id,
              description: 'Estorno',
              amount: '50.00',
            },
          ],
          acknowledgeTotalMismatch: true,
        }),
      ).resolves.toMatchObject({ status: 'applied' });

      const july = await tx
        .select()
        .from(transactions)
        .where(
          and(
            eq(transactions.userId, user.id),
            eq(transactions.destinationAccountId, card.id),
            eq(transactions.billingMonth, 7),
            eq(transactions.billingYear, 2026),
          ),
        );
      expect(july.map((item) => item.domainType)).toEqual(
        expect.arrayContaining([
          'credit_card_expense',
          'credit_card_installment',
          'credit_card_fixed_charge',
          'credit_card_refund',
        ]),
      );
      expect(july.find((item) => item.domainType === 'credit_card_installment')).toMatchObject({
        installmentNumber: 3,
        totalInstallments: 10,
      });
      const [series] = await tx
        .select()
        .from(scheduledTransactions)
        .where(
          and(
            eq(scheduledTransactions.userId, user.id),
            eq(scheduledTransactions.domainType, 'credit_card_installment'),
          ),
        );
      expect(series).toMatchObject({
        startingOccurrence: 1,
        firstBillingMonth: 5,
        purchaseDate: '2026-04-05',
        purchaseDateSource: 'institution',
      });
      const installments = await tx
        .select()
        .from(transactions)
        .where(eq(transactions.scheduledTransactionId, series?.id ?? ''));
      expect(installments).toHaveLength(10);
      expect(
        installments
          .filter((item) => item.isPaid)
          .map((item) => item.installmentNumber)
          .sort(),
      ).toEqual([1, 2]);
      expect(new Set(installments.map((item) => item.date.toISOString())).size).toBe(10);
    });
  });

  it('updates a reviewed one-time expense directly', async () => {
    await withRollback(async (tx) => {
      const user = await createTestUser(tx);
      const { expense, card, flow } = await setup(tx, user.id);
      await flow.addOneTimeExpense(user.id, {
        creditCardAccountId: card.id,
        expenseAccountId: expense.id,
        description: 'Uber Trip',
        amount: '25.75',
        billingMonth: 7,
        billingYear: 2026,
      });
      const service = new FaturaImportService(tx, {
        parser: fakeParser(
          faturaFixture({
            statedTotal: '25.90',
            cards: [
              {
                lastFour: null,
                holderName: null,
                isAdditional: false,
                items: [
                  {
                    description: 'UBER TRIP',
                    amountBRL: '25.90',
                    purchaseDate: null,
                    installmentCurrent: null,
                    installmentTotal: null,
                    isRefund: false,
                  },
                ],
              },
            ],
          }),
        ),
        now: NOW,
      });
      const draft = await service.createDraft(user.id, {
        cardAccountId: card.id,
        fileName: 'julho.pdf',
        externalConsent: true,
        pdfBase64: PDF_BASE64,
      });
      const reviewed = draft.itemsJson.matchResult.review[0];
      expect(reviewed?.expected.scheduleId).toBeNull();
      await expect(
        service.apply(user.id, {
          importId: draft.id,
          reviewedPeriod: { month: draft.billingMonth, year: draft.billingYear },
          expenseAccountId: expense.id,
          decisions: [
            {
              kind: 'update_expense',
              transactionId: reviewed?.expected.transactionId ?? '',
              amount: '999.99',
            },
          ],
          acknowledgeTotalMismatch: true,
        }),
      ).rejects.toThrow(/review|fatura/i);
      await service.apply(user.id, {
        importId: draft.id,
        reviewedPeriod: { month: draft.billingMonth, year: draft.billingYear },
        expenseAccountId: expense.id,
        decisions: [
          {
            kind: 'update_expense',
            transactionId: reviewed?.expected.transactionId ?? '',
            amount: '25.90',
          },
        ],
      });
      const [updatedTransaction] = await tx
        .select()
        .from(transactions)
        .where(eq(transactions.id, reviewed?.expected.transactionId ?? ''));
      expect(updatedTransaction).toMatchObject({ description: 'Uber Trip', amount: '25.90' });
    });
  });

  it('applies a new additional-card item to its persisted target card', async () => {
    await withRollback(async (tx) => {
      const user = await createTestUser(tx);
      const { expense, card, flow } = await setup(tx, user.id);
      const { account: additional } = await flow.createCreditCard(user.id, {
        name: 'Cartão Camila',
        closingDay: 8,
        dueDay: 15,
        parentAccountId: card.id,
      });
      const service = new FaturaImportService(tx, {
        parser: fakeParser({
          dueDate: '2026-07-15',
          statedTotal: '288.42',
          cards: [faturaFixture().cards[1] as ParsedFatura['cards'][number]],
        }),
        now: NOW,
      });
      const draft = await service.createDraft(user.id, {
        cardAccountId: card.id,
        fileName: 'adicional.pdf',
        externalConsent: true,
        pdfBase64: PDF_BASE64,
      });
      expect(draft.itemsJson.suggestions[0]?.targetCardAccountId).toBe(additional.id);

      await service.apply(user.id, {
        importId: draft.id,
        reviewedPeriod: { month: draft.billingMonth, year: draft.billingYear },
        expenseAccountId: expense.id,
        decisions: [
          {
            kind: 'add_expense',
            suggestionIndex: 0,
            targetCardAccountId: additional.id,
            description: 'Sephora (Camila)',
            amount: '288.42',
          },
        ],
      });

      const [created] = await tx
        .select()
        .from(transactions)
        .where(
          and(
            eq(transactions.userId, user.id),
            eq(transactions.destinationAccountId, additional.id),
            eq(transactions.description, 'Sephora (Camila)'),
          ),
        );
      expect(created).toBeDefined();
    });
  });

  it('rejects arbitrary or repeated creation decisions and keeps the draft unapplied', async () => {
    await withRollback(async (tx) => {
      const user = await createTestUser(tx);
      const { expense, card } = await setup(tx, user.id);
      const service = new FaturaImportService(tx, {
        parser: fakeParser(faturaFixture()),
        now: NOW,
      });
      const draft = await service.createDraft(user.id, {
        cardAccountId: card.id,
        fileName: 'julho.pdf',
        externalConsent: true,
        pdfBase64: PDF_BASE64,
      });
      const valid = {
        kind: 'add_expense' as const,
        suggestionIndex: 0,
        targetCardAccountId: card.id,
        description: 'Uber Trip',
        amount: '25.90',
      };

      await expect(
        service.apply(user.id, {
          importId: draft.id,
          reviewedPeriod: { month: draft.billingMonth, year: draft.billingYear },
          expenseAccountId: expense.id,
          decisions: [{ ...valid, amount: '999.99' }],
        }),
      ).rejects.toThrow(/itens novos/i);
      await expect(
        service.apply(user.id, {
          importId: draft.id,
          reviewedPeriod: { month: draft.billingMonth, year: draft.billingYear },
          expenseAccountId: expense.id,
          decisions: [valid, valid],
        }),
      ).rejects.toThrow(/itens novos/i);
      expect((await service.get(user.id, draft.id)).status).toBe('draft');
    });
  });

  it('requires an explicit acknowledgement when accepted decisions do not match the total', async () => {
    await withRollback(async (tx) => {
      const user = await createTestUser(tx);
      const { expense, card } = await setup(tx, user.id);
      const service = new FaturaImportService(tx, {
        parser: fakeParser(faturaFixture()),
        now: NOW,
      });
      const draft = await service.createDraft(user.id, {
        cardAccountId: card.id,
        fileName: 'julho.pdf',
        externalConsent: true,
        pdfBase64: PDF_BASE64,
      });

      await expect(
        service.apply(user.id, {
          importId: draft.id,
          reviewedPeriod: { month: draft.billingMonth, year: draft.billingYear },
          expenseAccountId: expense.id,
          decisions: [{ kind: 'skip' }],
        }),
      ).rejects.toThrow(/confirme explicitamente/i);
      expect((await service.get(user.id, draft.id)).status).toBe('draft');
    });
  });

  it('records the exact apply decisions in the audit log', async () => {
    await withRollback(async (tx) => {
      const user = await createTestUser(tx);
      const { expense, card } = await setup(tx, user.id);
      const service = new FaturaImportService(tx, {
        parser: fakeParser(faturaFixture()),
        now: NOW,
      });
      const draft = await service.createDraft(user.id, {
        cardAccountId: card.id,
        fileName: 'julho.pdf',
        externalConsent: true,
        pdfBase64: PDF_BASE64,
      });

      await service.apply(user.id, {
        importId: draft.id,
        reviewedPeriod: { month: draft.billingMonth, year: draft.billingYear },
        expenseAccountId: expense.id,
        decisions: [{ kind: 'skip' }],
        acknowledgeTotalMismatch: true,
      });

      const [entry] = await tx
        .select()
        .from(auditLog)
        .where(
          and(
            eq(auditLog.userId, user.id),
            eq(auditLog.entityType, 'fatura_import'),
            eq(auditLog.entityId, draft.id),
          ),
        );
      expect(entry).toMatchObject({
        action: 'apply',
        newData: {
          decisions: [{ kind: 'skip' }],
          acknowledgeTotalMismatch: true,
        },
      });
    });
  });

  it('returns the applied import on retry and rejects a schedule from another card', async () => {
    await withRollback(async (tx) => {
      const user = await createTestUser(tx);
      const { expense, card } = await setup(tx, user.id);
      const other = await setup(tx, user.id);
      const { schedule } = await other.flow.addFixedCharge(user.id, {
        creditCardAccountId: other.card.id,
        expenseAccountId: other.expense.id,
        description: 'Other Netflix',
        amount: '20.00',
        startDate: new Date(2026, 6, 1),
        dueDay: 15,
        firstBillingMonth: 7,
        firstBillingYear: 2026,
      });
      const service = new FaturaImportService(tx, {
        parser: fakeParser(faturaFixture()),
        now: NOW,
      });
      const draft = await service.createDraft(user.id, {
        cardAccountId: card.id,
        fileName: 'julho.pdf',
        externalConsent: true,
        pdfBase64: PDF_BASE64,
      });
      await expect(
        service.apply(user.id, {
          importId: draft.id,
          reviewedPeriod: { month: draft.billingMonth, year: draft.billingYear },
          expenseAccountId: expense.id,
          decisions: [{ kind: 'update_schedule_amount', scheduleId: schedule.id, amount: '30.00' }],
        }),
      ).rejects.toThrow(/rascunho|fatura|cartão|review/i);

      await service.apply(user.id, {
        importId: draft.id,
        reviewedPeriod: { month: draft.billingMonth, year: draft.billingYear },
        expenseAccountId: expense.id,
        decisions: [{ kind: 'skip' }],
        acknowledgeTotalMismatch: true,
      });
      await expect(
        service.apply(user.id, {
          importId: draft.id,
          reviewedPeriod: { month: draft.billingMonth, year: draft.billingYear },
          expenseAccountId: expense.id,
          decisions: [{ kind: 'skip' }],
        }),
      ).resolves.toMatchObject({ status: 'applied' });

      const [row] = await tx.select().from(faturaImports).where(eq(faturaImports.id, draft.id));
      expect(row?.status).toBe('applied');
    });
  });

  it('rejects draft creation and apply when the card is archived', async () => {
    await withRollback(async (tx) => {
      const user = await createTestUser(tx);
      const { expense, card } = await setup(tx, user.id);
      const service = new FaturaImportService(tx, {
        parser: fakeParser(faturaFixture()),
        now: NOW,
      });

      const draft = await service.createDraft(user.id, {
        cardAccountId: card.id,
        fileName: 'julho.pdf',
        externalConsent: true,
        pdfBase64: PDF_BASE64,
      });
      await tx.update(accounts).set({ isActive: false }).where(eq(accounts.id, card.id));

      await expect(
        service.createDraft(user.id, {
          cardAccountId: card.id,
          fileName: 'arquivado.pdf',
          externalConsent: true,
          pdfBase64: PDF_BASE64,
        }),
      ).rejects.toMatchObject({ code: 'CONFLICT', message: 'CARD_ARCHIVED' });
      await expect(
        service.apply(user.id, {
          importId: draft.id,
          reviewedPeriod: { month: draft.billingMonth, year: draft.billingYear },
          expenseAccountId: expense.id,
          decisions: [{ kind: 'skip' }],
          acknowledgeTotalMismatch: true,
        }),
      ).rejects.toMatchObject({ code: 'CONFLICT', message: 'CARD_ARCHIVED' });
    });
  });
});
