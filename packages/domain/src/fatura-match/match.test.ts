import { describe, expect, it } from 'vitest';
import { matchFaturaItems } from './match.ts';
import type { ExpectedItem, ParsedItem } from './types.ts';

function parsed(overrides: Partial<ParsedItem> = {}): ParsedItem {
  return {
    description: 'UBER TRIP',
    amountBRL: '25.90',
    purchaseDate: '2026-07-02',
    installmentCurrent: null,
    installmentTotal: null,
    isRefund: false,
    cardLastFour: null,
    holderName: null,
    isAdditional: false,
    ...overrides,
  };
}

function expected(overrides: Partial<ExpectedItem> = {}): ExpectedItem {
  return {
    transactionId: 'tx-1',
    cardAccountId: 'card-1',
    scheduleId: null,
    description: 'Uber Trip',
    amountBRL: '25.90',
    date: '2026-07-02',
    domainType: 'credit_card_expense',
    installmentNumber: null,
    totalInstallments: null,
    ...overrides,
  };
}

describe('matchFaturaItems', () => {
  it('automatically matches an identical item', () => {
    const result = matchFaturaItems({ parsed: [parsed()], expected: [expected()], aliases: {} });
    expect(result.matched).toHaveLength(1);
    expect(result.review).toHaveLength(0);
    expect(result.newOnFatura).toHaveLength(0);
    expect(result.missingInSystem).toHaveLength(0);
  });

  it('automatically matches a one-cent difference', () => {
    const result = matchFaturaItems({
      parsed: [parsed({ amountBRL: '25.91' })],
      expected: [expected()],
      aliases: {},
    });
    expect(result.matched).toHaveLength(1);
  });

  it('requires review for a difference up to twenty cents', () => {
    const result = matchFaturaItems({
      parsed: [parsed({ amountBRL: '26.05' })],
      expected: [expected()],
      aliases: {},
    });
    expect(result.review[0]?.reasons).toContain('valor_aproximado');
  });

  it('does not match a common purchase differing by more than twenty cents', () => {
    const result = matchFaturaItems({
      parsed: [parsed({ amountBRL: '26.11' })],
      expected: [expected()],
      aliases: {},
    });
    expect(result.review).toHaveLength(0);
    expect(result.newOnFatura).toHaveLength(1);
    expect(result.missingInSystem).toHaveLength(1);
  });

  it('requires review for a fuzzy merchant name with exact amount', () => {
    const result = matchFaturaItems({
      parsed: [parsed({ description: 'POSTO SHELL CENTRO NORTE' })],
      expected: [expected({ description: 'Posto Ipiranga Centro Norte' })],
      aliases: {},
    });
    expect(result.review[0]?.reasons).toContain('nome_aproximado');
  });

  it('reviews a changed subscription price', () => {
    const result = matchFaturaItems({
      parsed: [parsed({ description: 'NETFLIX COM', amountBRL: '59.90' })],
      expected: [
        expected({
          description: 'Netflix',
          amountBRL: '55.90',
          domainType: 'credit_card_fixed_charge',
          scheduleId: 'sched-net',
        }),
      ],
      aliases: {},
    });
    expect(result.review[0]?.reasons).toContain('assinatura_preco');
  });

  it('reviews divergent installment position and count', () => {
    const result = matchFaturaItems({
      parsed: [parsed({ installmentCurrent: 4, installmentTotal: 10 })],
      expected: [
        expected({
          scheduleId: 'sched-1',
          domainType: 'credit_card_installment',
          installmentNumber: 3,
          totalInstallments: 12,
        }),
      ],
      aliases: {},
    });
    expect(result.review[0]?.reasons).toEqual(
      expect.arrayContaining(['parcela_numero', 'parcela_total']),
    );
  });

  it('matches a truncated name through exact amount and equal installment signals', () => {
    const result = matchFaturaItems({
      parsed: [
        parsed({
          description: 'LOCACAO DE KITPARC07/12',
          amountBRL: '41.67',
          installmentCurrent: 7,
          installmentTotal: 12,
        }),
      ],
      expected: [
        expected({
          description: 'Locação de Kitnets',
          amountBRL: '41.67',
          scheduleId: 'sched-kit',
          domainType: 'credit_card_installment',
          installmentNumber: 7,
          totalInstallments: 12,
        }),
      ],
      aliases: {},
    });
    expect(result.newOnFatura).toHaveLength(0);
    expect(result.review[0]?.reasons).toEqual(['nome_aproximado']);
  });

  it('reviews a small cent difference when installment position and count are equal', () => {
    const result = matchFaturaItems({
      parsed: [
        parsed({
          description: 'MERCADOLIVRE*MUNDODOSCOMP',
          amountBRL: '49.99',
          installmentCurrent: 4,
          installmentTotal: 6,
        }),
      ],
      expected: [
        expected({
          description: 'MERCADOLIVRE*MUNDODOSCOMP',
          amountBRL: '49.94',
          scheduleId: 'sched-small-cent-difference',
          domainType: 'credit_card_installment',
          installmentNumber: 4,
          totalInstallments: 6,
        }),
      ],
      aliases: {},
    });

    expect(result.matched).toHaveLength(0);
    expect(result.review).toEqual([
      expect.objectContaining({
        parsed: expect.objectContaining({ amountBRL: '49.99' }),
        expected: expect.objectContaining({ amountBRL: '49.94' }),
        reasons: ['valor_aproximado'],
      }),
    ]);
    expect(result.newOnFatura).toHaveLength(0);
    expect(result.missingInSystem).toHaveLength(0);
  });

  it('reviews a unique installment using amount and k/n when descriptions are unrelated', () => {
    const result = matchFaturaItems({
      parsed: [
        parsed({
          description: 'MERCADOLIVRE*RELAXMEDIC',
          amountBRL: '216.62',
          installmentCurrent: 2,
          installmentTotal: 12,
        }),
      ],
      expected: [
        expected({
          description: 'Compra 2',
          amountBRL: '216.62',
          scheduleId: 'sched-manual-description',
          domainType: 'credit_card_installment',
          installmentNumber: 2,
          totalInstallments: 12,
        }),
      ],
      aliases: {},
    });

    expect(result.review).toEqual([
      expect.objectContaining({
        parsed: expect.objectContaining({ description: 'MERCADOLIVRE*RELAXMEDIC' }),
        expected: expect.objectContaining({ description: 'Compra 2' }),
        reasons: ['nome_aproximado'],
      }),
    ]);
    expect(result.newOnFatura).toHaveLength(0);
    expect(result.missingInSystem).toHaveLength(0);
  });

  it('reviews a unique unrelated-name installment with a small cent difference', () => {
    const result = matchFaturaItems({
      parsed: [
        parsed({
          description: 'MERCADOLIVRE*RELAXMEDIC',
          amountBRL: '216.62',
          installmentCurrent: 2,
          installmentTotal: 12,
        }),
      ],
      expected: [
        expected({
          description: 'Compra 2',
          amountBRL: '216.57',
          scheduleId: 'sched-manual-description',
          domainType: 'credit_card_installment',
          installmentNumber: 2,
          totalInstallments: 12,
        }),
      ],
      aliases: {},
    });

    expect(result.review[0]?.reasons).toEqual(['nome_aproximado', 'valor_aproximado']);
    expect(result.newOnFatura).toHaveLength(0);
    expect(result.missingInSystem).toHaveLength(0);
  });

  it('reviews a uniquely valued fixed charge even when the statement name is unrelated', () => {
    const result = matchFaturaItems({
      parsed: [parsed({ description: 'MP *PRODUTOSGLOBO', amountBRL: '27.93' })],
      expected: [
        expected({
          description: 'Globoplay',
          amountBRL: '27.93',
          scheduleId: 'sched-globoplay',
          domainType: 'credit_card_fixed_charge',
        }),
      ],
      aliases: {},
    });

    expect(result.review).toEqual([
      expect.objectContaining({
        parsed: expect.objectContaining({ description: 'MP *PRODUTOSGLOBO' }),
        expected: expect.objectContaining({ description: 'Globoplay' }),
        reasons: ['nome_aproximado'],
      }),
    ]);
    expect(result.newOnFatura).toHaveLength(0);
    expect(result.missingInSystem).toHaveLength(0);
  });

  it('reviews a uniquely valued one-time purchase registered under a manual name', () => {
    const result = matchFaturaItems({
      parsed: [parsed({ description: 'DL *UBERRIDES', amountBRL: '16.95' })],
      expected: [expected({ description: 'Uber 1', amountBRL: '16.95' })],
      aliases: {},
    });

    expect(result.review).toEqual([
      expect.objectContaining({
        parsed: expect.objectContaining({ description: 'DL *UBERRIDES' }),
        expected: expect.objectContaining({ description: 'Uber 1' }),
        reasons: ['nome_aproximado'],
      }),
    ]);
    expect(result.newOnFatura).toHaveLength(0);
    expect(result.missingInSystem).toHaveLength(0);
  });

  it('allows a one-cent standalone difference only when the value is mutually unique', () => {
    const result = matchFaturaItems({
      parsed: [parsed({ description: 'NU SEGURO LAR', amountBRL: '179.26' })],
      expected: [
        expected({
          description: 'mensalidade seguro casa',
          amountBRL: '179.25',
          scheduleId: 'sched-home-insurance',
          domainType: 'credit_card_fixed_charge',
        }),
      ],
      aliases: {},
    });

    expect(result.review).toEqual([
      expect.objectContaining({
        expected: expect.objectContaining({ description: 'mensalidade seguro casa' }),
        reasons: ['nome_aproximado'],
      }),
    ]);
  });

  it('does not guess between unrelated standalone purchases with the same value', () => {
    const result = matchFaturaItems({
      parsed: [
        parsed({ description: 'DL *UBERRIDES', amountBRL: '16.95' }),
        parsed({ description: 'IFD*RESTAURANTE', amountBRL: '16.95' }),
      ],
      expected: [expected({ description: 'Compra manual', amountBRL: '16.95' })],
      aliases: {},
    });

    expect(result.review).toHaveLength(0);
    expect(result.newOnFatura).toHaveLength(2);
    expect(result.missingInSystem).toHaveLength(1);
  });

  it('does not guess when one statement installment has multiple signal-equivalent candidates', () => {
    const result = matchFaturaItems({
      parsed: [
        parsed({
          description: 'MERCADOLIVRE*RELAXMEDIC',
          amountBRL: '216.62',
          installmentCurrent: 2,
          installmentTotal: 12,
        }),
      ],
      expected: [
        expected({
          transactionId: 'manual-1',
          description: 'Compra 2',
          amountBRL: '216.62',
          scheduleId: 'sched-manual-1',
          domainType: 'credit_card_installment',
          installmentNumber: 2,
          totalInstallments: 12,
        }),
        expected({
          transactionId: 'manual-2',
          description: 'Presente',
          amountBRL: '216.62',
          scheduleId: 'sched-manual-2',
          domainType: 'credit_card_installment',
          installmentNumber: 2,
          totalInstallments: 12,
        }),
      ],
      aliases: {},
    });

    expect(result.review).toHaveLength(0);
    expect(result.newOnFatura).toHaveLength(1);
    expect(result.missingInSystem).toHaveLength(2);
  });

  it('does not guess when multiple statement installments target one generic system item', () => {
    const result = matchFaturaItems({
      parsed: [
        parsed({
          description: 'MERCADOLIVRE*RELAXMEDIC',
          amountBRL: '216.62',
          installmentCurrent: 2,
          installmentTotal: 12,
        }),
        parsed({
          description: 'LOJA*OUTROPRODUTO',
          amountBRL: '216.62',
          installmentCurrent: 2,
          installmentTotal: 12,
        }),
      ],
      expected: [
        expected({
          description: 'Compra 2',
          amountBRL: '216.62',
          scheduleId: 'sched-manual-description',
          domainType: 'credit_card_installment',
          installmentNumber: 2,
          totalInstallments: 12,
        }),
      ],
      aliases: {},
    });

    expect(result.review).toHaveLength(0);
    expect(result.newOnFatura).toHaveLength(2);
    expect(result.missingInSystem).toHaveLength(1);
  });

  it('reviews mutually unique system installments when the statement omits k/n', () => {
    const result = matchFaturaItems({
      parsed: [
        parsed({
          description: 'LOCACAO DE KITNETS PORTO ALEGRE 076',
          amountBRL: '135.83',
        }),
        parsed({
          description: 'LOCACAO DE KITNETS PORTO ALEGRE 076',
          amountBRL: '233.33',
        }),
        parsed({
          description: 'LOCACAO DE KITNETS PORTO ALEGRE 076',
          amountBRL: '150.00',
        }),
        parsed({
          description: 'LEROY MERLIN SAO PAULO 076',
          amountBRL: '319.73',
        }),
      ],
      expected: [
        expected({
          transactionId: 'ton-julho',
          description: 'Ton Julho',
          amountBRL: '135.83',
          scheduleId: 'sched-ton-julho',
          domainType: 'credit_card_installment',
          installmentNumber: 12,
          totalInstallments: 12,
        }),
        expected({
          transactionId: 'ton-4',
          description: 'ton 4',
          amountBRL: '233.33',
          scheduleId: 'sched-ton-4',
          domainType: 'credit_card_installment',
          installmentNumber: 10,
          totalInstallments: 12,
        }),
        expected({
          transactionId: 'ton-dezembro',
          description: 'ton Dezembro',
          amountBRL: '150.00',
          scheduleId: 'sched-ton-dezembro',
          domainType: 'credit_card_installment',
          installmentNumber: 7,
          totalInstallments: 12,
        }),
        expected({
          description: 'Janela escritório',
          amountBRL: '319.73',
          scheduleId: 'sched-window',
          domainType: 'credit_card_installment',
          installmentNumber: 1,
          totalInstallments: 8,
        }),
      ],
      aliases: {},
    });

    expect(result.matched).toHaveLength(0);
    expect(result.review).toHaveLength(4);
    expect(result.review).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          parsed: expect.objectContaining({ amountBRL: '135.83' }),
          expected: expect.objectContaining({ description: 'Ton Julho' }),
          reasons: ['nome_aproximado', 'parcela_ausente_na_fatura'],
        }),
        expect.objectContaining({
          parsed: expect.objectContaining({ amountBRL: '233.33' }),
          expected: expect.objectContaining({ description: 'ton 4' }),
          reasons: ['nome_aproximado', 'parcela_ausente_na_fatura'],
        }),
        expect.objectContaining({
          parsed: expect.objectContaining({ amountBRL: '150.00' }),
          expected: expect.objectContaining({ description: 'ton Dezembro' }),
          reasons: ['nome_aproximado', 'parcela_ausente_na_fatura'],
        }),
        expect.objectContaining({
          parsed: expect.objectContaining({ description: 'LEROY MERLIN SAO PAULO 076' }),
          expected: expect.objectContaining({ description: 'Janela escritório' }),
          reasons: ['nome_aproximado', 'parcela_ausente_na_fatura'],
        }),
      ]),
    );
    expect(result.newOnFatura).toHaveLength(0);
    expect(result.missingInSystem).toHaveLength(0);
  });

  it('does not guess between equal-value installments when the statement omits k/n', () => {
    const result = matchFaturaItems({
      parsed: [
        parsed({ description: 'LOJA A', amountBRL: '150.00' }),
        parsed({ description: 'LOJA B', amountBRL: '150.00' }),
      ],
      expected: [
        expected({
          description: 'Compra manual',
          amountBRL: '150.00',
          scheduleId: 'sched-manual',
          domainType: 'credit_card_installment',
          installmentNumber: 7,
          totalInstallments: 12,
        }),
      ],
      aliases: {},
    });

    expect(result.review).toHaveLength(0);
    expect(result.newOnFatura).toHaveLength(2);
    expect(result.missingInSystem).toHaveLength(1);
  });

  it('does not guess which equal-value system installment lacks k/n on the statement', () => {
    const result = matchFaturaItems({
      parsed: [parsed({ description: 'LOJA', amountBRL: '150.00' })],
      expected: [
        expected({
          transactionId: 'installment-a',
          description: 'Compra A',
          amountBRL: '150.00',
          scheduleId: 'sched-a',
          domainType: 'credit_card_installment',
          installmentNumber: 7,
          totalInstallments: 12,
        }),
        expected({
          transactionId: 'installment-b',
          description: 'Compra B',
          amountBRL: '150.00',
          scheduleId: 'sched-b',
          domainType: 'credit_card_installment',
          installmentNumber: 3,
          totalInstallments: 10,
        }),
      ],
      aliases: {},
    });

    expect(result.review).toHaveLength(0);
    expect(result.newOnFatura).toHaveLength(1);
    expect(result.missingInSystem).toHaveLength(2);
  });

  it('prefers the closest amount between otherwise equivalent installment candidates', () => {
    const result = matchFaturaItems({
      parsed: [
        parsed({
          description: 'MERCADOLIVRE*MERCADOLIVRE',
          amountBRL: '49.99',
          installmentCurrent: 4,
          installmentTotal: 6,
        }),
      ],
      expected: [
        expected({
          transactionId: 'farther',
          description: 'MERCADOLIVRE*MERCADOLIVRE',
          amountBRL: '49.85',
          scheduleId: 'sched-farther',
          domainType: 'credit_card_installment',
          installmentNumber: 4,
          totalInstallments: 6,
        }),
        expected({
          transactionId: 'closer',
          description: 'MERCADOLIVRE*MERCADOLIVRE',
          amountBRL: '49.94',
          scheduleId: 'sched-closer',
          domainType: 'credit_card_installment',
          installmentNumber: 4,
          totalInstallments: 6,
        }),
      ],
      aliases: {},
    });

    expect(result.review[0]?.expected.transactionId).toBe('closer');
    expect(result.missingInSystem).toEqual([expect.objectContaining({ transactionId: 'farther' })]);
  });

  it('only matches a refund to an expected refund', () => {
    const result = matchFaturaItems({
      parsed: [parsed({ description: 'ESTORNO LOJA X', amountBRL: '50.00', isRefund: true })],
      expected: [expected({ description: 'Estorno Loja X', amountBRL: '50.00' })],
      aliases: {},
    });
    expect(result.matched).toHaveLength(0);
    expect(result.newOnFatura).toHaveLength(1);
    expect(result.missingInSystem).toHaveLength(1);
  });

  it('uses an alias to match different statement and system names', () => {
    const result = matchFaturaItems({
      parsed: [parsed({ description: 'DL*MELIMAIS', amountBRL: '19.90' })],
      expected: [expected({ description: 'Meli+ Camila', amountBRL: '19.90' })],
      aliases: { 'dl melimais': 'Meli+ Camila' },
    });
    expect(result.matched).toHaveLength(1);
  });

  it('uses a learned schedule rule without matching another schedule with the same label', () => {
    const result = matchFaturaItems({
      parsed: [parsed({ description: 'ANTHROPIC* CLAUDE SUB', amountBRL: '1183.35' })],
      expected: [
        expected({
          description: 'claude max',
          amountBRL: '1162.79',
          scheduleId: 'target-schedule',
          domainType: 'credit_card_fixed_charge',
        }),
        expected({
          description: 'claude max',
          amountBRL: '1183.35',
          scheduleId: 'other-schedule',
          domainType: 'credit_card_fixed_charge',
        }),
      ],
      aliases: {},
      learnedScheduleIds: { 'anthropic claude sub': 'target-schedule' },
    });

    expect(result.review).toEqual([
      expect.objectContaining({
        expected: expect.objectContaining({ scheduleId: 'target-schedule' }),
        reasons: ['assinatura_preco'],
      }),
    ]);
    expect(result.missingInSystem).toEqual([
      expect.objectContaining({ scheduleId: 'other-schedule' }),
    ]);
  });

  it('does not consume the same expected item twice', () => {
    const result = matchFaturaItems({
      parsed: [parsed(), parsed()],
      expected: [expected()],
      aliases: {},
    });
    expect(result.matched).toHaveLength(1);
    expect(result.newOnFatura).toHaveLength(1);
  });

  it('prefers the exact compact merchant over a generic fuzzy candidate', () => {
    const exact = parsed({
      description: 'MERCADOLIVREMUNDODOSCOMP',
      amountBRL: '49.90',
      installmentCurrent: 16,
      installmentTotal: 18,
    });
    const generic = parsed({
      description: 'MERCADOLIVRE*MERCADOLIVRE',
      amountBRL: '49.77',
      installmentCurrent: 16,
      installmentTotal: 18,
    });
    const result = matchFaturaItems({
      parsed: [exact, generic],
      expected: [
        expected({
          description: 'MERCADOLIVRE*MUNDODOSCOMP',
          amountBRL: '49.77',
          installmentNumber: 16,
          totalInstallments: 18,
          domainType: 'credit_card_installment',
          scheduleId: 'schedule-1',
        }),
      ],
      aliases: {},
    });

    expect(result.review[0]?.parsed).toBe(exact);
    expect(result.newOnFatura).toEqual([generic]);
  });

  it('does not pair unrelated installments only because their totals match', () => {
    const result = matchFaturaItems({
      parsed: [
        parsed({
          description: 'MERCADOLIVRE*MERCADOLIVRE',
          amountBRL: '91.48',
          installmentCurrent: 1,
          installmentTotal: 18,
        }),
      ],
      expected: [
        expected({
          description: 'MERCADOLIVRE*MUNDODOSCOMP',
          amountBRL: '49.77',
          installmentNumber: 16,
          totalInstallments: 18,
          domainType: 'credit_card_installment',
          scheduleId: 'schedule-1',
        }),
      ],
      aliases: {},
    });

    expect(result.review).toHaveLength(0);
    expect(result.newOnFatura).toHaveLength(1);
    expect(result.missingInSystem).toHaveLength(1);
  });

  it('preserves additional-card metadata in unmatched buckets', () => {
    const result = matchFaturaItems({
      parsed: [
        parsed({
          description: 'SEPHORA',
          amountBRL: '288.42',
          cardLastFour: '8516',
          holderName: 'CAMILA STEINMETZ',
          isAdditional: true,
        }),
      ],
      expected: [],
      aliases: {},
    });
    expect(result.newOnFatura[0]).toMatchObject({
      holderName: 'CAMILA STEINMETZ',
      isAdditional: true,
    });
  });
});
