import type { ParsedFatura } from '@fc/domain';
import {
  EXTRACT_FATURA_TOOL,
  FATURA_EXTRACTION_RULES,
  parseExtractedFatura,
} from './extraction-contract.ts';
import type { FaturaProfile } from './profiles.ts';

const OUTER_JSON_FENCE = /^```(?:json)?[ \t]*\r?\n([\s\S]*?)\r?\n```$/i;

export function buildManualFaturaPrompt(profile: FaturaProfile): string {
  return [
    'Analise o PDF de fatura anexado seguindo todas as regras abaixo.',
    '',
    ...FATURA_EXTRACTION_RULES.map((rule) => `- ${rule}`),
    '',
    `Perfil do emissor: ${profile.label} (${profile.id})`,
    profile.hints,
    '',
    'Retorne somente o objeto JSON, sem Markdown, comentários ou explicações.',
    'O JSON deve obedecer exatamente a este schema; não inclua propriedades adicionais:',
    JSON.stringify(EXTRACT_FATURA_TOOL.input_schema, null, 2),
  ].join('\n');
}

export function parseManualFaturaResponse(raw: string): ParsedFatura {
  const trimmed = raw.trim();
  const fenced = OUTER_JSON_FENCE.exec(trimmed);
  const json = fenced?.[1] ?? trimmed;
  return parseExtractedFatura(JSON.parse(json));
}
