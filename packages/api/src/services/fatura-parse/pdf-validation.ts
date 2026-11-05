import { TRPCError } from '@trpc/server';
import { PDFDocument } from 'pdf-lib';

export const STATEMENT_PARSER_LIMITS = {
  maxBytes: 3 * 1024 * 1024,
  maxPages: 50,
  timeoutMs: 60_000,
} as const;
const BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

export function statementParserCapabilities() {
  return {
    available: Boolean(process.env.ANTHROPIC_API_KEY?.trim()),
    provider: 'Anthropic' as const,
    ...STATEMENT_PARSER_LIMITS,
  };
}

export async function validateStatementPdf(pdfBase64: string): Promise<number> {
  if (!pdfBase64 || !BASE64.test(pdfBase64))
    throw new TRPCError({
      code: 'BAD_REQUEST',
      message: 'statement.unreadablePdf',
      cause: { i18nKey: 'statement.unreadablePdf' },
    });
  const bytes = Buffer.from(pdfBase64, 'base64');
  if (bytes.length > STATEMENT_PARSER_LIMITS.maxBytes)
    throw new TRPCError({
      code: 'BAD_REQUEST',
      message: 'statement.pdfTooLarge',
      cause: { i18nKey: 'statement.pdfTooLarge' },
    });
  try {
    const document = await PDFDocument.load(bytes, {
      updateMetadata: false,
      throwOnInvalidObject: true,
      ignoreEncryption: true,
    });
    if (document.isEncrypted)
      throw new TRPCError({
        code: 'BAD_REQUEST',
        message: 'statement.protectedPdf',
        cause: { i18nKey: 'statement.protectedPdf' },
      });
    const pages = document.getPageCount();
    if (pages > STATEMENT_PARSER_LIMITS.maxPages)
      throw new TRPCError({
        code: 'BAD_REQUEST',
        message: 'statement.tooManyPages',
        cause: { i18nKey: 'statement.tooManyPages' },
      });
    if (pages === 0) throw new Error('Empty PDF');
    return pages;
  } catch (error) {
    if (error instanceof TRPCError) throw error;
    throw new TRPCError({
      code: 'BAD_REQUEST',
      message: 'statement.unreadablePdf',
      cause: { i18nKey: 'statement.unreadablePdf' },
    });
  }
}
