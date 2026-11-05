import { isCalendarDate, type ParsedFatura } from '@fc/domain';
import { z } from 'zod';

const money = z.string().regex(/^\d+\.\d{2}$/);
const positiveMoneyPattern = /^(?:0\.(?:0[1-9]|[1-9]\d)|[1-9]\d{0,7}\.\d{2})$/;
const positiveMoney = z.string().regex(positiveMoneyPattern);
const isoDate = z.string().refine(isCalendarDate, 'Invalid calendar date');

const parsedItemSchema = z
  .object({
    description: z.string().min(1).max(300),
    amountBRL: positiveMoney,
    purchaseDate: isoDate.nullable(),
    postedDate: isoDate.nullable().optional(),
    installmentCurrent: z.number().int().min(1).max(120).nullable(),
    installmentTotal: z.number().int().min(1).max(120).nullable(),
    isRefund: z.boolean(),
  })
  .strict();

const parsedCardSchema = z
  .object({
    lastFour: z.string().max(8).nullable(),
    holderName: z.string().max(120).nullable(),
    isAdditional: z.boolean(),
    items: z.array(parsedItemSchema).max(500),
  })
  .strict();

export const parsedFaturaSchema = z
  .object({
    dueDate: isoDate,
    closingDate: isoDate.nullable().optional(),
    ignoredPreviousBalance: money.nullable().optional(),
    ignoredPayments: money.nullable().optional(),
    statedTotal: money.nullable(),
    cards: z.array(parsedCardSchema).max(20),
  })
  .strict()
  .superRefine((fatura, context) => {
    const itemCount = fatura.cards.reduce((total, card) => total + card.items.length, 0);
    if (itemCount === 0 && fatura.statedTotal !== '0.00') {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['cards'],
        message:
          'A extração não encontrou lançamentos, embora a fatura não tenha total zero. Reprocesse o PDF com leitura visual/OCR.',
      });
    }
    if (itemCount > 500) {
      context.addIssue({
        code: z.ZodIssueCode.too_big,
        maximum: 500,
        inclusive: true,
        origin: 'array',
        path: ['cards'],
        message: 'A fatura não pode conter mais de 500 lançamentos',
      });
    }
  });

export const EXTRACT_FATURA_TOOL = {
  name: 'extract_fatura',
  description: 'Retorna dados estruturados extraídos de uma fatura de cartão brasileira.',
  strict: true,
  input_schema: {
    type: 'object',
    additionalProperties: false,
    required: [
      'dueDate',
      'closingDate',
      'ignoredPreviousBalance',
      'ignoredPayments',
      'statedTotal',
      'cards',
    ],
    properties: {
      dueDate: { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$' },
      closingDate: { type: ['string', 'null'], pattern: '^\\d{4}-\\d{2}-\\d{2}$' },
      ignoredPreviousBalance: { type: ['string', 'null'], pattern: '^\\d+\\.\\d{2}$' },
      ignoredPayments: { type: ['string', 'null'], pattern: '^\\d+\\.\\d{2}$' },
      statedTotal: { type: ['string', 'null'], pattern: '^\\d+\\.\\d{2}$' },
      cards: {
        origin: 'array',
        maxItems: 20,
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['lastFour', 'holderName', 'isAdditional', 'items'],
          properties: {
            lastFour: { type: ['string', 'null'], maxLength: 8 },
            holderName: { type: ['string', 'null'], maxLength: 120 },
            isAdditional: { type: 'boolean' },
            items: {
              origin: 'array',
              maxItems: 500,
              items: {
                type: 'object',
                additionalProperties: false,
                required: [
                  'description',
                  'amountBRL',
                  'purchaseDate',
                  'postedDate',
                  'installmentCurrent',
                  'installmentTotal',
                  'isRefund',
                ],
                properties: {
                  description: { type: 'string', minLength: 1, maxLength: 300 },
                  amountBRL: { type: 'string', pattern: positiveMoneyPattern.source },
                  purchaseDate: {
                    type: ['string', 'null'],
                    pattern: '^\\d{4}-\\d{2}-\\d{2}$',
                  },
                  postedDate: { type: ['string', 'null'], pattern: '^\\d{4}-\\d{2}-\\d{2}$' },
                  installmentCurrent: {
                    type: ['integer', 'null'],
                    minimum: 1,
                    maximum: 120,
                  },
                  installmentTotal: {
                    type: ['integer', 'null'],
                    minimum: 1,
                    maximum: 120,
                  },
                  isRefund: { type: 'boolean' },
                },
              },
            },
          },
        },
      },
    },
  },
} as const;

export const FATURA_EXTRACTION_INPUT_SCHEMA = EXTRACT_FATURA_TOOL.input_schema;

export const FATURA_EXTRACTION_RULES = [
  'Informe closingDate e postedDate apenas quando explicitamente presentes; ausência é null. Nunca confunda compra, lançamento e fechamento.',
  'Informe os totais de saldo anterior e pagamentos ignorados em ignoredPreviousBalance e ignoredPayments, sem incluí-los nos items. Ausência é null.',
  'Extraia UMA fatura de cartão de crédito brasileira do PDF anexado.',
  'Inspecione visualmente TODAS as páginas. Se uma página não tiver camada de texto, parecer vazia na extração ou for formada por vetores/imagens, renderize-a como imagem e aplique OCR; não use somente o texto extraído do PDF.',
  'Use o vencimento e total desta fatura no resumo, não datas ou totais do boleto.',
  'Crie um card por cartão físico, virtual ou adicional quando houver agrupamento.',
  'isAdditional só é true quando o portador é outra pessoa.',
  'Inclua os lançamentos que formam o total desta fatura: compras, parcelas, tarifas, anuidade, IOF, juros, estornos e créditos.',
  'Exclua saldo anterior, limites, simulações, boleto e lançamentos de próximas faturas.',
  'Não exclua automaticamente linhas descritas como pagamento de fatura. Reconcilie todos os pagamentos com o saldo ou total da fatura anterior e aloque os pagamentos ao saldo anterior primeiro.',
  'Exclua somente a parcela dos pagamentos que quita a fatura anterior. Se os pagamentos superarem o saldo anterior, inclua o excedente que reduz o total atual como um único lançamento com isRefund=true e amountBRL positivo; se uma linha cruzar o saldo restante, use somente a parte excedente.',
  'Quando houver totalizadores, confira o cálculo: excedente de pagamento = max(total de pagamentos - saldo anterior, 0). Créditos e estornos separados não fazem parte desse total de pagamentos e também devem ser extraídos.',
  'Não classifique todo pagamento como estorno: sem excedente sobre o saldo anterior, ele deve ser excluído.',
  'Exclua linhas com valor 0,00: elas são apenas informativas e não representam cobrança nem estorno efetivo.',
  'Estornos têm isRefund=true e amountBRL positivo.',
  'amountBRL é o valor lançado neste mês, nunca o preço total de uma compra parcelada.',
  'Preserve os separadores e a grafia do estabelecimento na description; remova somente o marcador de parcela k/n.',
  'Extraia parcela k/n em qualquer grafia, inclusive quando várias parcelas da mesma compra aparecem na fatura.',
  'purchaseDate é a data original da compra em YYYY-MM-DD ou null quando não for resolvível.',
  'Não invente nem deduplique lançamentos idênticos.',
  'Não retorne cards vazio nem cards sem items quando statedTotal for diferente de 0.00. Nesse caso, a tabela de lançamentos ainda não foi lida: reinspecione visualmente as páginas.',
  'Antes de responder, some cobranças menos estornos e compare com statedTotal. Se não fechar, releia todas as tabelas de lançamentos para localizar linhas omitidas; nunca invente valores para forçar o fechamento.',
];

export const ANTHROPIC_SYSTEM_PROMPT = [
  ...FATURA_EXTRACTION_RULES,
  'Responda somente via tool extract_fatura.',
].join('\n');

export function parseExtractedFatura(
  input: unknown,
  options: { sanitizeInvalidInstallments?: boolean } = {},
): ParsedFatura {
  const fatura = parsedFaturaSchema.parse(input);
  return {
    ...fatura,
    cards: fatura.cards.map((card, cardIndex) => ({
      ...card,
      items: card.items.map((item, itemIndex) => {
        const incomplete = (item.installmentCurrent === null) !== (item.installmentTotal === null);
        const impossible =
          item.installmentCurrent !== null &&
          item.installmentTotal !== null &&
          item.installmentCurrent > item.installmentTotal;
        if (!incomplete && !impossible) return item;
        if (options.sanitizeInvalidInstallments === true) {
          return { ...item, installmentCurrent: null, installmentTotal: null };
        }
        throw new z.ZodError([
          {
            code: z.ZodIssueCode.custom,
            path: ['cards', cardIndex, 'items', itemIndex, 'installmentCurrent'],
            message: 'Parcela deve ter current/total válidos e current não pode exceder total',
          },
        ]);
      }),
    })),
  };
}
