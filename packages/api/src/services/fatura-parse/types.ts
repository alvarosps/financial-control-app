import type { ParsedFatura } from '@fc/domain';
import type { FaturaProfile } from './profiles.ts';

export type ParseFaturaInput = {
  pdfBase64: string;
  profile: FaturaProfile;
  signal?: AbortSignal;
};

export type FaturaPdfParser = {
  readonly model: string;
  parse(input: ParseFaturaInput): Promise<ParsedFatura>;
};
