import type { ParsedFatura } from '@fc/domain';
import { z } from 'zod';
import {
  FATURA_EXTRACTION_INPUT_SCHEMA,
  FATURA_EXTRACTION_RULES,
  parseExtractedFatura,
} from './extraction-contract.ts';
import type { FaturaProfile } from './profiles.ts';

const MAX_STATEMENTS = 20;
const MAX_ITEMS = 2000;

const bulkEnvelopeSchema = z
  .object({
    statements: z
      .array(
        z
          .object({
            reference: z.string().min(1).max(100),
            fatura: z.unknown(),
          })
          .strict(),
      )
      .max(MAX_STATEMENTS),
  })
  .strict();

export type BulkPromptManifestItem = {
  reference: string;
  cardName: string;
  profile: FaturaProfile;
};

export type BulkParsedStatement =
  | { reference: string; status: 'valid'; fatura: ParsedFatura }
  | { reference: string; status: 'invalid'; message: string };

export function buildBulkManualFaturaPrompt(items: BulkPromptManifestItem[]): string {
  const manifest = items.map(({ reference, cardName, profile }) => ({
    reference,
    cardName,
    profileId: profile.id,
  }));
  const profiles = items.map(({ reference, profile }) =>
    [`${reference}: ${profile.label} (${profile.id})`, profile.hints].join('\n'),
  );

  return [
    'Analise uma fatura de cartÃ£o de crÃ©dito brasileira para cada PDF anexado.',
    '',
    ...FATURA_EXTRACTION_RULES,
    '',
    'Manifesto ordenado de cartÃµes:',
    JSON.stringify(manifest, null, 2),
    '',
    'InstruÃ§Ãµes especÃ­ficas por referÃªncia:',
    ...profiles,
    '',
    'Retorne somente JSON, sem Markdown, comentÃ¡rios ou explicaÃ§Ãµes.',
    'Retorne todas e apenas as referÃªncias do manifesto, sem inventar referÃªncias.',
    'Use este envelope: { "statements": [{ "reference": "card-1", "fatura": { ... } }] }.',
    'Cada fatura deve obedecer exatamente a este schema; nÃ£o inclua propriedades adicionais:',
    JSON.stringify(FATURA_EXTRACTION_INPUT_SCHEMA, null, 2),
  ].join('\n');
}

export function parseBulkManualFaturaResponse(
  raw: string,
  expectedReferences: string[],
): BulkParsedStatement[] {
  if (expectedReferences.length === 0 || expectedReferences.length > MAX_STATEMENTS) {
    throw new Error(`O lote deve conter entre 1 e ${MAX_STATEMENTS} cartÃµes`);
  }

  const envelope = bulkEnvelopeSchema.parse(JSON.parse(raw.trim()));
  const expected = new Set(expectedReferences);
  if (expected.size !== expectedReferences.length) {
    throw new Error('As referÃªncias esperadas devem ser Ãºnicas');
  }

  const received = new Set<string>();
  for (const statement of envelope.statements) {
    if (!expected.has(statement.reference)) {
      throw new Error(`ReferÃªncia desconhecida: ${statement.reference}`);
    }
    if (received.has(statement.reference)) {
      throw new Error(`ReferÃªncia duplicada: ${statement.reference}`);
    }
    received.add(statement.reference);
  }

  if (countItems(envelope.statements) > MAX_ITEMS) {
    throw new Error(`O lote nÃ£o pode conter mais de ${MAX_ITEMS} lanÃ§amentos`);
  }

  const statementsByReference = new Map(
    envelope.statements.map((statement) => [statement.reference, statement.fatura]),
  );

  return expectedReferences.map((reference) => {
    const fatura = statementsByReference.get(reference);
    if (fatura === undefined) {
      return { reference, status: 'invalid', message: 'Fatura ausente na resposta do lote' };
    }

    try {
      return { reference, status: 'valid', fatura: parseExtractedFatura(fatura) };
    } catch {
      return { reference, status: 'invalid', message: 'Fatura invÃ¡lida na resposta do lote' };
    }
  });
}

function countItems(statements: Array<{ fatura?: unknown }>): number {
  return statements.reduce((total, { fatura }) => {
    if (!isRecord(fatura) || !Array.isArray(fatura.cards)) return total;

    return (
      total +
      fatura.cards.reduce(
        (cardTotal, card) =>
          cardTotal + (isRecord(card) && Array.isArray(card.items) ? card.items.length : 0),
        0,
      )
    );
  }, 0);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}
