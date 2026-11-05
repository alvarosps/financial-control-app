import type { ParsedFatura } from '@fc/domain';
import { describe, expect, it } from 'vitest';
import {
  buildBulkManualFaturaPrompt,
  parseBulkManualFaturaResponse,
} from './bulk-manual-fatura.ts';
import { FATURA_EXTRACTION_INPUT_SCHEMA } from './extraction-contract.ts';
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

describe('buildBulkManualFaturaPrompt', () => {
  it('keeps ordered references, issuer profiles, and one shared fatura schema', () => {
    const prompt = buildBulkManualFaturaPrompt([
      { reference: 'card-1', cardName: 'Santander', profile: getFaturaProfile('santander') },
      { reference: 'card-2', cardName: 'Carrefour', profile: getFaturaProfile('carrefour') },
    ]);

    expect(prompt).toContain('"reference": "card-1"');
    expect(prompt).toContain('"reference": "card-2"');
    expect(prompt).toContain('Santander');
    expect(prompt).toContain('aloque os pagamentos ao saldo anterior primeiro');
    expect(prompt).toContain('PAGAMENTO DE FATURA-INTERNET');
    expect(prompt).toContain('isRefund=true');
    expect(prompt).toContain('CARTAO VIRTUAL');
    const schema = JSON.stringify(FATURA_EXTRACTION_INPUT_SCHEMA, null, 2);
    expect(prompt.split(schema)).toHaveLength(2);
  });
});

describe('parseBulkManualFaturaResponse', () => {
  it('parses each valid fatura independently', () => {
    expect(
      parseBulkManualFaturaResponse(
        JSON.stringify({
          statements: [
            { reference: 'card-1', fatura: VALID_FATURA },
            { reference: 'card-2', fatura: { ...VALID_FATURA, dueDate: '2026-07-20' } },
          ],
        }),
        ['card-1', 'card-2'],
      ),
    ).toEqual([
      { reference: 'card-1', status: 'valid', fatura: VALID_FATURA },
      {
        reference: 'card-2',
        status: 'valid',
        fatura: { ...VALID_FATURA, dueDate: '2026-07-20' },
      },
    ]);
  });

  it('keeps schema-invalid and missing faturas as independent errors', () => {
    const results = parseBulkManualFaturaResponse(
      JSON.stringify({
        statements: [{ reference: 'card-1', fatura: { ...VALID_FATURA, unexpected: true } }],
      }),
      ['card-1', 'card-2'],
    );

    expect(results[0]).toMatchObject({ reference: 'card-1', status: 'invalid' });
    expect(results[1]).toMatchObject({ reference: 'card-2', status: 'invalid' });
  });

  it.each([
    [
      {
        statements: [
          { reference: 'card-1', fatura: VALID_FATURA },
          { reference: 'card-1', fatura: VALID_FATURA },
        ],
      },
    ],
    [{ statements: [{ reference: 'unknown', fatura: VALID_FATURA }] }],
  ])('rejects untrusted reference envelopes', (response) => {
    expect(() => parseBulkManualFaturaResponse(JSON.stringify(response), ['card-1'])).toThrow();
  });

  it('rejects malformed outer JSON, prose, and oversized batches', () => {
    expect(() => parseBulkManualFaturaResponse('{', ['card-1'])).toThrow();
    expect(() =>
      parseBulkManualFaturaResponse(`Resposta: ${JSON.stringify({ statements: [] })}`, ['card-1']),
    ).toThrow();
    expect(() =>
      parseBulkManualFaturaResponse(
        JSON.stringify({
          statements: Array.from({ length: 21 }, (_, index) => ({
            reference: `card-${index + 1}`,
            fatura: VALID_FATURA,
          })),
        }),
        Array.from({ length: 21 }, (_, index) => `card-${index + 1}`),
      ),
    ).toThrow();
    expect(() =>
      parseBulkManualFaturaResponse(
        JSON.stringify({
          statements: [
            {
              reference: 'card-1',
              fatura: {
                ...VALID_FATURA,
                cards: [
                  {
                    ...VALID_FATURA.cards[0],
                    items: Array.from({ length: 2001 }, () => VALID_FATURA.cards[0]?.items[0]),
                  },
                ],
              },
            },
          ],
        }),
        ['card-1'],
      ),
    ).toThrow();
  });
});
