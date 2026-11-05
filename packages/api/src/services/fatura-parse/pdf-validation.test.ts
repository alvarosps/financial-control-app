import { PDFDocument } from 'pdf-lib';
import { expect, it } from 'vitest';
import { validateStatementPdf } from './pdf-validation.ts';

it('validates actual pages and rejects protected or unreadable PDFs locally', async () => {
  const document = await PDFDocument.create();
  document.addPage();
  const valid = await document.saveAsBase64();
  await expect(validateStatementPdf(valid)).resolves.toBe(1);
  await expect(
    validateStatementPdf(Buffer.from('%PDF-1.4 broken').toString('base64')),
  ).rejects.toThrow('statement.unreadablePdf');
  for (let i = 1; i < 51; i++) document.addPage();
  await expect(validateStatementPdf(await document.saveAsBase64())).rejects.toThrow(
    'statement.tooManyPages',
  );
  document.context.trailerInfo.Encrypt = document.context.register(
    document.context.obj({ Filter: 'Standard' }),
  );
  await expect(validateStatementPdf(await document.saveAsBase64())).rejects.toThrow(
    'statement.protectedPdf',
  );
});
