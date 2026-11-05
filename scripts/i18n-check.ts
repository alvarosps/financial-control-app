#!/usr/bin/env tsx
/**
 * i18n:check — fail CI if new raw Portuguese strings land in apps/web.
 *
 * Scans every `.ts`/`.tsx` file under `apps/web/src/**` (excluding message
 * files and test files) for string literals and JSX text containing
 * Portuguese unicode characters or a PT-keyword heuristic. Exits with a
 * non-zero status listing offenders if any are found.
 *
 * Allowlist:
 *   - Files in `apps/web/src/i18n/messages/**` (translation source).
 *   - Any `*.test.*` file.
 *
 * The `i18n-ignore` comment escape hatch has been removed — every UI string
 * must live in a translation file. If you believe a string is genuinely
 * non-user-visible (log output, data-field fallback, seeded identifier),
 * move the constant to `@fc/shared` or `@fc/domain` so it is clearly not UI
 * copy.
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(__dirname, '..');
const WEB_SRC = path.join(ROOT, 'apps', 'web', 'src');
const MESSAGES_DIR = path.join(WEB_SRC, 'i18n', 'messages');
const HASH_KEY = /\.[0-9a-f]{6}$/;
const HASH_ALLOWLIST_PREFIXES = [
  'app-dashboard-monthly-spending-page.',
  'app-dashboard-monthly-spending-monthlyspendingclient.',
  'components-monthly-spending-',
];

const PT_UNICODE = /[áàâãéêíóôõúüçÁÀÂÃÉÊÍÓÔÕÚÜÇ]/;
const PT_KEYWORD =
  /\b(Salvar|Cancelar|Excluir|Editar|Adicionar|Remover|Sim|Não|Carregando|Voltar|Criar|Fechar|Confirmar|Pagar|Pago|Pendente|Atrasado|Nenhum(a)?|Descrição|Categoria|Mês|Empréstimo|Despesa|Renda|Fatura|Parcela|Próximo|Anterior|Atual|Buscar)\b/;

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) {
      out.push(...walk(full));
    } else if (/\.(ts|tsx)$/.test(entry)) {
      out.push(full);
    }
  }
  return out;
}

function relWeb(p: string) {
  return path.relative(WEB_SRC, p).replace(/\\/g, '/');
}

function shouldSkip(filePath: string): boolean {
  const rel = relWeb(filePath);
  if (rel.startsWith('i18n/messages/')) return true;
  if (rel.includes('/__tests__/')) return true;
  if (/\.test\.(ts|tsx)$/.test(rel)) return true;
  if (/\.d\.ts$/.test(rel)) return true;
  return false;
}

type Offense = { file: string; line: number; snippet: string };

function isPtLiteral(s: string): boolean {
  if (!s) return false;
  if (PT_UNICODE.test(s)) return true;
  if (PT_KEYWORD.test(s)) return true;
  return false;
}

function check(file: string): Offense[] {
  const source = readFileSync(file, 'utf8');
  const lines = source.split(/\r?\n/);
  const offenses: Offense[] = [];

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    // Skip comment-only lines
    const stripped = line.trim();
    if (stripped.startsWith('//')) continue;
    if (stripped.startsWith('*') || stripped.startsWith('/*')) continue;

    // String literals: single, double, and backtick without interpolation.
    const literals = line.match(/(['"])(?:(?=(\\?))\2.)*?\1/g) ?? [];
    for (const lit of literals) {
      const inner = lit.slice(1, -1);
      if (isPtLiteral(inner)) {
        offenses.push({ file, line: i + 1, snippet: line.trim() });
        break; // one offense per line is enough
      }
    }
    // JSX text between > and < — crude but effective.
    const jsxTexts = line.match(/>([^<>{}]{3,})</g) ?? [];
    for (const raw of jsxTexts) {
      const text = raw.slice(1, -1).trim();
      if (isPtLiteral(text)) {
        offenses.push({ file, line: i + 1, snippet: line.trim() });
        break;
      }
    }
  }
  return offenses;
}

function flattenKeys(obj: Record<string, unknown>, prefix = ''): string[] {
  return Object.entries(obj).flatMap(([key, value]) => {
    const fullKey = prefix ? `${prefix}.${key}` : key;
    return value !== null && typeof value === 'object'
      ? flattenKeys(value as Record<string, unknown>, fullKey)
      : [fullKey];
  });
}

function findHashKeys(): string[] {
  const en = JSON.parse(readFileSync(path.join(MESSAGES_DIR, 'en.json'), 'utf8')) as Record<
    string,
    unknown
  >;
  return flattenKeys(en).filter(
    (key) =>
      HASH_KEY.test(key) && !HASH_ALLOWLIST_PREFIXES.some((prefix) => key.startsWith(prefix)),
  );
}

function main() {
  const files = walk(WEB_SRC).filter((f) => !shouldSkip(f));
  const offenses: Offense[] = [];
  for (const f of files) offenses.push(...check(f));
  const hashKeys = findHashKeys();

  if (offenses.length === 0 && hashKeys.length === 0) {
    console.log(
      `i18n:check passed (${files.length} files scanned, 0 raw PT strings, 0 hash keys).`,
    );
    return;
  }

  if (hashKeys.length > 0) {
    console.error(`i18n:check FAILED — ${hashKeys.length} hash-named key(s) in en.json:`);
    for (const key of hashKeys) console.error(`  ${key}`);
  }
  if (offenses.length === 0) process.exit(1);

  console.error(`i18n:check FAILED — ${offenses.length} raw PT string(s) found:`);
  for (const o of offenses) {
    console.error(`  ${relWeb(o.file)}:${o.line}: ${o.snippet}`);
  }
  console.error('\nFix by:');
  console.error(
    "  - Replace with t('<key>') and add the key to apps/web/src/i18n/messages/{pt-BR,en}.json, or",
  );
  console.error(
    '  - If the string is intentionally non-UI (system identifier, log output), move it to a constants module in `@fc/shared` or `@fc/domain` so it lives outside `apps/web/src`.',
  );
  process.exit(1);
}

main();
