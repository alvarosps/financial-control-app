import type { ParsedFatura } from '@fc/domain';
import { describe, expect, it } from 'vitest';
import { EXTRACT_FATURA_TOOL } from './extraction-contract.ts';
import { buildManualFaturaPrompt, parseManualFaturaResponse } from './manual-fatura.ts';
import { getFaturaProfile } from './profiles.ts';

const VALID_FATURA: ParsedFatura = {
  dueDate: '2026-07-15',
  statedTotal: '25.90',
  cards: [
    {
      lastFour: '9859',
      holderName: 'ALVARO SOUZA',
      isAdditional: false,
      items: [
        {
          description: 'UBER TRIP',
          amountBRL: '25.90',
          purchaseDate: '2026-06-02',
          installmentCurrent: null,
          installmentTotal: null,
          isRefund: false,
        },
      ],
    },
  ],
};

describe('buildManualFaturaPrompt', () => {
  it('includes universal rules, issuer hints, strict schema, and JSON-only output', () => {
    const prompt = buildManualFaturaPrompt(getFaturaProfile('riachuelo'));

    expect(prompt).toContain('Riachuelo (Midway)');
    expect(prompt).toContain('Lançamento do mês');
    expect(prompt).toContain('Renderize obrigatoriamente a página 1 como imagem');
    expect(prompt).toContain('Histórico de Despesas');
    expect(prompt).toContain('Continue depois de SUBTOTAL');
    expect(prompt).toContain('inclua ANUIDADE');
    expect(prompt).toContain('não tiver camada de texto');
    expect(prompt).toContain('Não retorne cards vazio');
    expect(prompt).toContain('Exclua linhas com valor 0,00');
    expect(prompt).toContain('aloque os pagamentos ao saldo anterior primeiro');
    expect(prompt).toContain('excedente');
    expect(prompt).toContain('isRefund=true');
    expect(prompt).toContain('Retorne somente o objeto JSON');
    expect(prompt).toContain('additionalProperties');
    expect(prompt).toContain('installmentCurrent');
  });

  it.each([
    ['santander', 'Saldo Anterior', 'PAGAMENTO DE FATURA-INTERNET'],
    ['leroy-merlin', 'Total da Fatura Anterior', 'PAGAMENTO FATURA PIX'],
  ])('reconciles advance payments for %s before excluding them', (profileId, ...hints) => {
    const prompt = buildManualFaturaPrompt(getFaturaProfile(profileId));

    for (const hint of hints) expect(prompt).toContain(hint);
    expect(prompt).toContain('excedente');
    expect(prompt).toContain('isRefund=true');
  });

  it('distinguishes Mercado Pago statement payments from purchase credits', () => {
    const prompt = buildManualFaturaPrompt(getFaturaProfile('mercadopago'));

    expect(prompt).toContain('Em Pagamento da fatura, ignore somente a parte');
    expect(prompt).toContain('Inclua Crédito concedido como estorno');
    expect(prompt).toContain('não deduplique parcelas repetidas');
    expect(prompt).toContain('Preserve os separadores');
  });

  it('instructs BRB extraction to keep every statement row despite future-looking dates', () => {
    const prompt = buildManualFaturaPrompt(getFaturaProfile('brb'));

    expect(prompt).toContain('TODAS as linhas');
    expect(prompt).toContain('data impressa seja posterior ao vencimento');
    expect(prompt).toContain('compare com statedTotal');
  });

  it.each([
    ['bistek', 'Bistek / DM', 'página 5', 'FATURA ANTERIOR'],
    ['dm', 'DM Visa', 'página 5', 'PAGAMENTOS EFETUADOS'],
    ['leroy-merlin', 'Leroy Merlin Pay', 'DEMONSTRATIVO', 'sinal final'],
    ['carrefour', 'Carrefour', 'página 3', 'CARTAO VIRTUAL'],
  ])('includes issuer-specific visual instructions for %s', (profileId, label, ...hints) => {
    const prompt = buildManualFaturaPrompt(getFaturaProfile(profileId));

    expect(prompt).toContain(label);
    for (const hint of hints) expect(prompt).toContain(hint);
  });
});

describe('parseManualFaturaResponse', () => {
  it('parses a pure JSON response', () => {
    expect(parseManualFaturaResponse(JSON.stringify(VALID_FATURA))).toEqual(VALID_FATURA);
  });

  it('accepts one outer JSON Markdown fence', () => {
    const response = `\`\`\`json\n${JSON.stringify(VALID_FATURA)}\n\`\`\``;
    expect(parseManualFaturaResponse(response)).toEqual(VALID_FATURA);
  });

  it('rejects prose outside the JSON payload', () => {
    expect(() =>
      parseManualFaturaResponse(`Aqui está o resultado: ${JSON.stringify(VALID_FATURA)}`),
    ).toThrow();
  });

  it('rejects unknown fields', () => {
    expect(() =>
      parseManualFaturaResponse(JSON.stringify({ ...VALID_FATURA, explanation: 'extra' })),
    ).toThrow();
  });

  it('rejects an empty extraction unless the stated total is zero', () => {
    expect(() =>
      parseManualFaturaResponse(
        JSON.stringify({
          dueDate: '2026-07-13',
          statedTotal: null,
          cards: [],
        }),
      ),
    ).toThrow(/não encontrou lançamentos/);

    expect(() =>
      parseManualFaturaResponse(
        JSON.stringify({
          dueDate: '2026-07-13',
          statedTotal: '884.99',
          cards: [],
        }),
      ),
    ).toThrow(/não encontrou lançamentos/);

    expect(
      parseManualFaturaResponse(
        JSON.stringify({
          dueDate: '2026-07-13',
          statedTotal: '0.00',
          cards: [],
        }),
      ),
    ).toEqual({
      dueDate: '2026-07-13',
      statedTotal: '0.00',
      cards: [],
    });
  });

  it('rejects zero-valued items before they become invalid apply decisions', () => {
    const invalid = structuredClone(VALID_FATURA);
    const item = invalid.cards[0]?.items[0];
    expect(item).toBeDefined();
    if (item === undefined) return;
    item.amountBRL = '0.00';

    expect(() => parseManualFaturaResponse(JSON.stringify(invalid))).toThrow();

    const amountPattern =
      EXTRACT_FATURA_TOOL.input_schema.properties.cards.items.properties.items.items.properties
        .amountBRL.pattern;
    expect(new RegExp(amountPattern).test('0.00')).toBe(false);
    expect(new RegExp(amountPattern).test('0.01')).toBe(true);
    expect(new RegExp(amountPattern).test('99999999.99')).toBe(true);
    expect(new RegExp(amountPattern).test('100000000.00')).toBe(false);
  });

  it('rejects more than 20 cards and more than 500 items globally', () => {
    const card = VALID_FATURA.cards[0];
    expect(card).toBeDefined();
    if (card === undefined) return;

    expect(() =>
      parseManualFaturaResponse(
        JSON.stringify({ ...VALID_FATURA, cards: Array.from({ length: 21 }, () => card) }),
      ),
    ).toThrow();
    expect(() =>
      parseManualFaturaResponse(
        JSON.stringify({
          ...VALID_FATURA,
          cards: [{ ...card, items: Array.from({ length: 501 }, () => card.items[0]) }],
        }),
      ),
    ).toThrow();
    expect(() =>
      parseManualFaturaResponse(
        JSON.stringify({
          ...VALID_FATURA,
          cards: Array.from({ length: 2 }, () => ({
            ...card,
            items: Array.from({ length: 251 }, () => card.items[0]),
          })),
        }),
      ),
    ).toThrow();
  });

  it('rejects incomplete or impossible installment pairs', () => {
    const response = structuredClone(VALID_FATURA);
    const item = response.cards[0]?.items[0];
    if (item) {
      item.installmentCurrent = 5;
      item.installmentTotal = 2;
    }

    expect(() => parseManualFaturaResponse(JSON.stringify(response))).toThrow(/Parcela/);
  });
});
