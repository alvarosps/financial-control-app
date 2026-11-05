import { z } from 'zod';
import {
  ANTHROPIC_SYSTEM_PROMPT,
  EXTRACT_FATURA_TOOL,
  parseExtractedFatura,
} from './extraction-contract.ts';
import { STATEMENT_PARSER_LIMITS } from './pdf-validation.ts';
import type { FaturaPdfParser, ParseFaturaInput } from './types.ts';

const ANTHROPIC_URL = 'https://api.anthropic.com/v1/messages';
const DEFAULT_MODEL = 'claude-sonnet-5';
const MAX_TOKENS = 32_000;

const responseSchema = z.object({
  content: z.array(
    z.union([
      z
        .object({
          type: z.literal('tool_use'),
          id: z.string(),
          name: z.string(),
          input: z.unknown(),
        })
        .passthrough(),
      z.object({ type: z.literal('text'), text: z.string() }).passthrough(),
    ]),
  ),
});

export class ClaudeFaturaParser implements FaturaPdfParser {
  readonly model: string;
  private readonly apiKey: string;
  private readonly fetchFn: typeof fetch;

  constructor(options: { apiKey: string; model?: string; fetchFn?: typeof fetch }) {
    this.apiKey = options.apiKey;
    this.model = options.model ?? process.env.FATURA_PARSER_MODEL ?? DEFAULT_MODEL;
    this.fetchFn = options.fetchFn ?? fetch;
  }

  async parse(input: ParseFaturaInput) {
    const timeout = AbortSignal.timeout(STATEMENT_PARSER_LIMITS.timeoutMs);
    const signal = input.signal ? AbortSignal.any([input.signal, timeout]) : timeout;
    signal.throwIfAborted();
    const response = await this.fetchFn(ANTHROPIC_URL, {
      method: 'POST',
      signal,
      headers: {
        'content-type': 'application/json',
        'x-api-key': this.apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: this.model,
        max_tokens: MAX_TOKENS,
        thinking: { type: 'disabled' },
        system: ANTHROPIC_SYSTEM_PROMPT,
        messages: [
          {
            role: 'user',
            content: [
              {
                type: 'document',
                source: {
                  type: 'base64',
                  media_type: 'application/pdf',
                  data: input.pdfBase64,
                },
              },
              {
                type: 'text',
                text: `Perfil: ${input.profile.label} (${input.profile.id}).\n${input.profile.hints}`,
              },
            ],
          },
        ],
        tools: [EXTRACT_FATURA_TOOL],
        tool_choice: { type: 'tool', name: 'extract_fatura' },
      }),
    });

    if (!response.ok) {
      throw new Error(`Anthropic API respondeu ${response.status} ao extrair a fatura`);
    }

    const payload = responseSchema.parse(await response.json());
    const toolUse = payload.content.find(
      (block) => block.type === 'tool_use' && block.name === 'extract_fatura',
    );
    if (toolUse?.type !== 'tool_use') {
      throw new Error('Resposta da Anthropic sem bloco tool_use extract_fatura');
    }
    return parseExtractedFatura(toolUse.input, { sanitizeInvalidInstallments: true });
  }
}
