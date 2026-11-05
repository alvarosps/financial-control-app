import { readFileSync } from 'node:fs';
import { computeParsedTotals, flattenParsedCards, totalsDelta } from '@fc/domain';
import 'dotenv/config';
import { ClaudeFaturaParser } from '../src/services/fatura-parse/claude-pdf-parser.ts';
import { getFaturaProfile } from '../src/services/fatura-parse/profiles.ts';

const [pdfPath, profileId] = process.argv.slice(2);
if (pdfPath === undefined) {
  console.error('uso: parse-fatura.ts <caminho.pdf> <profileId>');
  process.exit(1);
}
const apiKey = process.env.ANTHROPIC_API_KEY;
if (apiKey === undefined || apiKey.length === 0) {
  console.error('ANTHROPIC_API_KEY não definida');
  process.exit(1);
}

const parser = new ClaudeFaturaParser({ apiKey });
const fatura = await parser.parse({
  pdfBase64: readFileSync(pdfPath).toString('base64'),
  profile: getFaturaProfile(profileId),
});
const items = flattenParsedCards(fatura.cards);
const totals = computeParsedTotals(items);

console.log(JSON.stringify(fatura, null, 2));
console.log('---');
console.log(`vencimento: ${fatura.dueDate}`);
console.log(`itens: ${items.length} em ${fatura.cards.length} cartão(ões)`);
console.log(
  `somado: ${totals.netTotal} | impresso: ${fatura.statedTotal ?? 'n/a'} | delta: ${totalsDelta(totals.netTotal, fatura.statedTotal) ?? 'n/a'}`,
);
