#!/usr/bin/env tsx
/**
 * i18n extraction codemod.
 *
 * Walks every `.ts`/`.tsx` file under `apps/web/src/**` (excluding message
 * files, __tests__, and anything matching `*.test.*`) and:
 *
 *  1. Identifies user-visible PT strings — JSX text, string-literal JSX
 *     children, string arguments to `toast.error/success/message`,
 *     `alert(...)`, and `throw new Error(...)`, plus JSX attribute values for
 *     `placeholder`, `title`, `alt`, `aria-label`, `label`.
 *  2. Filters by heuristic: string must contain a Portuguese unicode
 *     character (`ã/ç/á/é/í/ó/ú/â/ê/ô/õ/à/ü`) OR match a PT-keyword regex
 *     (Salvar, Cancelar, Erro, Excluir, Editar, Adicionar, Remover, Sim,
 *     Não, Carregando, Voltar, etc.). Skips values that are purely numeric,
 *     single-character, ALL_CAPS enum-like, or pure URLs/paths.
 *  3. Generates a flat key: `<relative-path-dashed>.<short-hash>` where the
 *     hash collapses duplicates to a shared key.
 *  4. Replaces the literal with `t('<key>')` or `{t('<key>')}` in JSX text.
 *  5. Adds `const t = useTranslations();` to the top of each touched
 *     component function, plus the corresponding import.
 *  6. Merges extracted keys into
 *     `apps/web/src/i18n/messages/pt-BR.json` under an `extracted.*`
 *     namespace so previously-authored keys (navigation, dashboard, …)
 *     survive. Drafts the same keys in `en.json` using a small dictionary.
 *
 * Usage:
 *   pnpm tsx scripts/i18n-extract.ts --dry    # preview only, no writes
 *   pnpm tsx scripts/i18n-extract.ts          # apply changes
 *
 * CAUTION: only simple literals are auto-replaced. Template literals,
 * ternaries, string concatenation, and conditionals are left alone and
 * surfaced in the report for manual migration.
 */

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import {
  type JsxAttribute,
  Node,
  Project,
  type SourceFile,
  type StringLiteral,
  SyntaxKind,
} from 'ts-morph';
import { markdownCodeSpan } from './lib/markdown.ts';

type Finding = {
  file: string;
  key: string;
  text: string;
  kind: 'jsx-text' | 'jsx-string-child' | 'jsx-attr' | 'call-arg' | 'error-arg';
  skipped?: string; // present when we chose not to auto-replace
};

const ROOT = path.resolve(__dirname, '..'); // financial-control-v2
const REPO_ROOT = path.resolve(ROOT, '..'); // outer repo (contains docs/)
const WEB_SRC = path.join(ROOT, 'apps', 'web', 'src');
const normalize = (p: string) => p.replace(/\\/g, '/');
const WEB_SRC_NORM = normalize(WEB_SRC);
const MESSAGES_DIR = path.join(WEB_SRC, 'i18n', 'messages');
const PT_FILE = path.join(MESSAGES_DIR, 'pt-BR.json');
const EN_FILE = path.join(MESSAGES_DIR, 'en.json');
const REPORT_PATH = path.resolve(
  REPO_ROOT,
  'docs',
  'superpowers',
  'specs',
  '2026-04-12-i18n-extraction-report.md',
);

const DRY = process.argv.includes('--dry');

const PT_UNICODE = /[áàâãéêíóôõúüçÁÀÂÃÉÊÍÓÔÕÚÜÇ]/;
const PT_KEYWORD =
  /\b(Salvar|Cancelar|Erro|Excluir|Editar|Adicionar|Remover|Sim|Não|Carregando|Voltar|Criar|Fechar|Confirmar|Pagar|Pago|Pendente|Atrasado|Ativo|Inativo|Nenhum(a)?|Total|Data|Valor|Descrição|Categoria|Nome|Mês|Ano|Conta|Fatura|Parcela|Cartão|Empréstimo|Despesa|Renda|Saldo|Próximo|Anterior|Atual|Buscar)\b/;

const SKIP_ATTRS = new Set([
  'className',
  'id',
  'data',
  'aria-hidden',
  'href',
  'src',
  'type',
  'role',
  'name',
  'key',
  'value',
  'htmlFor',
  'variant',
  'size',
  'step',
  'min',
  'max',
  'autoComplete',
  'inputMode',
  'fill',
  'stroke',
  'color',
  'dir',
  'lang',
  'rel',
  'target',
  'method',
  'encType',
]);
const KEEP_ATTRS = new Set(['placeholder', 'title', 'alt', 'aria-label', 'label', 'description']);

const SKIP_CALLS = new Set(['cn', 'clsx', 'classNames', 'twMerge', 'cva']);

/** English translations for common PT tokens — used to draft en.json. */
const EN_DICT: Array<[RegExp, string]> = [
  [/^Salvar\.?\.?\.?$/, 'Save'],
  [/^Cancelar$/, 'Cancel'],
  [/^Excluir$/, 'Delete'],
  [/^Editar$/, 'Edit'],
  [/^Adicionar$/, 'Add'],
  [/^Remover$/, 'Remove'],
  [/^Fechar$/, 'Close'],
  [/^Confirmar$/, 'Confirm'],
  [/^Voltar$/, 'Back'],
  [/^Criar$/, 'Create'],
  [/^Sim$/, 'Yes'],
  [/^Não$/, 'No'],
  [/^Carregando\.\.\.$/, 'Loading…'],
  [/^Erro$/, 'Error'],
  [/^Erro ao salvar\. Tente novamente\.$/, 'Save failed. Please try again.'],
  [/^Valor inválido$/, 'Invalid amount'],
  [/^Pagar Fatura$/, 'Pay Bill'],
  [/^Pagar$/, 'Pay'],
  [/^Pago$/, 'Paid'],
  [/^Pendente$/, 'Pending'],
  [/^Atrasado$/, 'Overdue'],
  [/^Ativo$/, 'Active'],
  [/^Inativo$/, 'Inactive'],
  [/^Descrição$/, 'Description'],
  [/^Categoria$/, 'Category'],
  [/^Valor \(R\$\)$/, 'Amount (R$)'],
  [/^Valor$/, 'Amount'],
  [/^Nome$/, 'Name'],
  [/^Mês$/, 'Month'],
  [/^Ano$/, 'Year'],
  [/^Parcela Atual$/, 'Current Installment'],
  [/^Total de Parcelas$/, 'Total Installments'],
  [/^Sem categoria$/, 'No category'],
  [/^Notas$/, 'Notes'],
  [/^Comentários opcionais$/, 'Optional comments'],
  [/^Editar Item$/, 'Edit Item'],
  [/^Adicionar Reembolso$/, 'Add Refund'],
  [/^Adicionar Parcela$/, 'Add Installment'],
  [/^Adicionar Cobrança Fixa$/, 'Add Fixed Charge'],
  [/^Adicionar Gasto Único$/, 'Add One-Off Expense'],
  [/^Adicionar Desconto$/, 'Add Discount'],
  [/^Adicionar Cartão Adicional$/, 'Add Additional Card'],
  [/^Salvando\.\.\.$/, 'Saving…'],
  [/^Criando\.\.\.$/, 'Creating…'],
  [/^Pagando\.\.\.$/, 'Paying…'],
  [/^Avançando\.\.\.$/, 'Advancing…'],
  [/^Avançar Mês$/, 'Advance Month'],
  [/^Marcar como Pago$/, 'Mark as Paid'],
  [/^Desativar$/, 'Deactivate'],
  [/^Quitado$/, 'Paid off'],
  [/^Buscar parcela\.\.\.$/, 'Search installment…'],
  [/^Buscar parcelas$/, 'Search installments'],
  [/^Nenhuma parcela encontrada$/, 'No installments found'],
  [/^Selecionar conta$/, 'Select account'],
  [/^Pagar com a conta$/, 'Pay from account'],
  [
    /^Nenhuma conta disponível para pagamento\. Crie uma conta corrente primeiro\.$/,
    'No account available for payment. Create a checking account first.',
  ],
  [/^Confirmar Pagamento$/, 'Confirm Payment'],
  [/^Criar Cartão$/, 'Create Card'],
  [/^Nome do cartão$/, 'Card name'],
];

function translate(pt: string): string {
  for (const [pattern, en] of EN_DICT) {
    if (pattern.test(pt)) return pt.replace(pattern, en);
  }
  // Fallback: return the PT string with a `[PT]` marker so human reviewers
  // can spot untranslated entries. Non-empty so parity test (values must be
  // non-empty) still passes.
  return `[PT] ${pt}`;
}

function shortHash(s: string): string {
  return createHash('sha1').update(s).digest('hex').slice(0, 6);
}

function relWeb(filePath: string): string {
  return path.relative(WEB_SRC, filePath).replace(/\\/g, '/');
}

function keyPrefix(filePath: string): string {
  const rel = relWeb(filePath).replace(/\.(tsx?|jsx?)$/, '');
  return (
    rel
      .replace(/[^\w/-]/g, '')
      .replace(/[/\\]/g, '-')
      .replace(/--+/g, '-')
      .toLowerCase() || 'misc'
  );
}

function shouldSkipValue(text: string): boolean {
  const trimmed = text.trim();
  if (trimmed.length <= 1) return true;
  if (/^\d+([.,]\d+)?$/.test(trimmed)) return true;
  if (/^[A-Z_]+$/.test(trimmed)) return true;
  if (/^https?:\/\//.test(trimmed)) return true;
  if (/^\/[\w\-./]+$/.test(trimmed)) return true;
  if (/^[a-z][\w-]*$/.test(trimmed) && !PT_UNICODE.test(trimmed) && !PT_KEYWORD.test(trimmed))
    return true; // looks like a css class / enum token
  return false;
}

function isPtString(text: string): boolean {
  if (shouldSkipValue(text)) return false;
  return PT_UNICODE.test(text) || PT_KEYWORD.test(text);
}

function _getComponentName(file: SourceFile): string {
  const exports = file.getExportedDeclarations().get('default')?.[0]?.getSymbol()?.getName();
  if (exports) return exports;
  // fall back to filename
  return path.basename(file.getFilePath(), path.extname(file.getFilePath()));
}

function addUseTranslationsHook(file: SourceFile) {
  // Ensure import
  const importDecl = file.getImportDeclaration('next-intl');
  if (importDecl) {
    const named = importDecl.getNamedImports().map((n) => n.getName());
    if (!named.includes('useTranslations')) {
      importDecl.addNamedImport('useTranslations');
    }
  } else {
    file.addImportDeclaration({
      moduleSpecifier: 'next-intl',
      namedImports: ['useTranslations'],
    });
  }

  // Add `const t = useTranslations();` to the default export function / component
  const funcs = file.getFunctions();
  for (const fn of funcs) {
    const body = fn.getBody();
    if (!body || !Node.isBlock(body)) continue;
    const text = body.getText();
    if (text.includes('useTranslations(')) continue;
    // Only inject into exported components (conservative)
    const isExport = fn.isExported();
    if (!isExport) continue;
    body.insertStatements(0, 'const t = useTranslations();');
  }
  // Also handle arrow-function exports (common): `export function X() {}` is above
  // For `export const X = () => { ... }` or `export default function X() {}`
  const varDecls = file.getVariableDeclarations();
  for (const vd of varDecls) {
    const init = vd.getInitializer();
    if (!init) continue;
    if (Node.isArrowFunction(init) || Node.isFunctionExpression(init)) {
      const body = init.getBody();
      if (!body || !Node.isBlock(body)) continue;
      const text = body.getText();
      if (text.includes('useTranslations(')) continue;
      const parent = vd.getVariableStatement();
      if (!parent?.isExported()) continue;
      body.insertStatements(0, 'const t = useTranslations();');
    }
  }
}

function processFile(file: SourceFile, ptMessages: Record<string, string>, findings: Finding[]) {
  const filePath = file.getFilePath();
  const prefix = keyPrefix(filePath);
  let touched = false;

  // Shared helper: register a PT string, return its key.
  const register = (text: string): string => {
    const key = `${prefix}.${shortHash(text)}`;
    ptMessages[key] = text;
    return key;
  };

  // --- JSX text nodes -----------------------------------------------------
  file.forEachDescendant((node) => {
    if (node.getKind() !== SyntaxKind.JsxText) return;
    const text = node.getText();
    const trimmed = text.trim();
    if (!trimmed || !isPtString(trimmed)) return;
    // Skip if inside an ignored element, e.g., <style>, <script> — rare in
    // this codebase, so we don't model it.
    const key = register(trimmed);
    findings.push({ file: filePath, key, text: trimmed, kind: 'jsx-text' });
    // Replace in source: preserve surrounding whitespace.
    const leading = text.match(/^\s*/)?.[0] ?? '';
    const trailing = text.match(/\s*$/)?.[0] ?? '';
    node.replaceWithText(`${leading}{t('${key}')}${trailing}`);
    touched = true;
  });

  // --- JSX attributes -----------------------------------------------------
  file.forEachDescendant((node) => {
    if (!Node.isJsxAttribute(node)) return;
    const attr = node as JsxAttribute;
    const nameNode = attr.getNameNode();
    const attrName = nameNode.getText();
    if (SKIP_ATTRS.has(attrName)) return;
    if (attrName.startsWith('data-') || attrName.startsWith('on')) return;
    if (!KEEP_ATTRS.has(attrName)) {
      // Allow any string-valued attr that looks PT — but only if it's in the
      // keep list OR the string is unambiguously PT (has unicode accent). We
      // keep it conservative to avoid touching technical attrs.
    }
    const init = attr.getInitializer();
    if (!init) return;
    if (Node.isStringLiteral(init)) {
      const text = init.getLiteralText();
      if (!isPtString(text)) return;
      if (!KEEP_ATTRS.has(attrName) && !PT_UNICODE.test(text)) return;
      const key = register(text);
      findings.push({ file: filePath, key, text, kind: 'jsx-attr' });
      init.replaceWithText(`{t('${key}')}`);
      touched = true;
    } else if (Node.isJsxExpression(init)) {
      const expr = init.getExpression();
      if (expr && Node.isStringLiteral(expr)) {
        const text = (expr as StringLiteral).getLiteralText();
        if (!isPtString(text)) return;
        if (!KEEP_ATTRS.has(attrName) && !PT_UNICODE.test(text)) return;
        const key = register(text);
        findings.push({ file: filePath, key, text, kind: 'jsx-attr' });
        (expr as StringLiteral).replaceWithText(`t('${key}')`);
        touched = true;
      }
    }
  });

  // --- toast/alert/throw Error args ---------------------------------------
  file.forEachDescendant((node) => {
    if (Node.isCallExpression(node)) {
      const expr = node.getExpression().getText();
      // Skip className/cva-style calls regardless of args
      if (SKIP_CALLS.has(expr.split('.').pop() ?? '')) return;
      const isToast = /^toast(\.(error|success|warning|info|message))?$/.test(expr);
      const isAlert = expr === 'alert';
      if (!isToast && !isAlert) return;
      const args = node.getArguments();
      if (args.length === 0) return;
      const first = args[0];
      if (Node.isStringLiteral(first)) {
        const text = (first as StringLiteral).getLiteralText();
        if (!isPtString(text)) return;
        const key = register(text);
        findings.push({ file: filePath, key, text, kind: 'call-arg' });
        (first as StringLiteral).replaceWithText(`t('${key}')`);
        touched = true;
      } else {
        // template / expression — leave alone, report
        const firstText = first.getText();
        if (isPtString(firstText)) {
          findings.push({
            file: filePath,
            key: '(unreplaced)',
            text: firstText.slice(0, 80),
            kind: 'call-arg',
            skipped: 'non-literal argument',
          });
        }
      }
    }
    if (Node.isNewExpression(node)) {
      const expr = node.getExpression().getText();
      if (expr !== 'Error') return;
      const args = node.getArguments();
      if (args.length === 0) return;
      const first = args[0];
      if (Node.isStringLiteral(first)) {
        const text = (first as StringLiteral).getLiteralText();
        if (!isPtString(text)) return;
        const key = register(text);
        findings.push({ file: filePath, key, text, kind: 'error-arg' });
        (first as StringLiteral).replaceWithText(`t('${key}')`);
        touched = true;
      }
    }
  });

  if (touched) {
    addUseTranslationsHook(file);
  }
  return touched;
}

async function main() {
  const project = new Project({
    tsConfigFilePath: path.join(WEB_SRC, '..', 'tsconfig.json'),
    skipAddingFilesFromTsConfig: false,
  });

  const files = project.getSourceFiles().filter((f) => {
    const p = normalize(f.getFilePath());
    if (!p.startsWith(WEB_SRC_NORM)) return false;
    if (p.includes('/i18n/messages/')) return false;
    if (p.includes('/__tests__/')) return false;
    if (/\.test\.tsx?$/.test(p)) return false;
    if (/\.d\.ts$/.test(p)) return false;
    return /\.(tsx|ts)$/.test(p);
  });

  const ptMessages: Record<string, string> = {};
  const findings: Finding[] = [];
  const touchedFiles: string[] = [];

  for (const file of files) {
    const before = findings.length;
    const touched = processFile(file, ptMessages, findings);
    if (touched) touchedFiles.push(file.getFilePath());
    const added = findings.length - before;
    if (added > 0) {
      // noop — summary in report
    }
  }

  // Merge with existing pt-BR.json under `extracted.*`
  const existingPt = JSON.parse(readFileSync(PT_FILE, 'utf8')) as Record<string, unknown>;
  const existingEn = JSON.parse(readFileSync(EN_FILE, 'utf8')) as Record<string, unknown>;

  const existingExtractedPt = (existingPt.extracted as Record<string, string>) ?? {};
  const existingExtractedEn = (existingEn.extracted as Record<string, string>) ?? {};

  const mergedExtractedPt: Record<string, string> = { ...existingExtractedPt, ...ptMessages };
  const mergedExtractedEn: Record<string, string> = { ...existingExtractedEn };
  for (const [k, v] of Object.entries(mergedExtractedPt)) {
    if (!mergedExtractedEn[k]) mergedExtractedEn[k] = translate(v);
  }

  // Sort keys for stable diff
  const sortKeys = (obj: Record<string, string>) =>
    Object.fromEntries(Object.entries(obj).sort(([a], [b]) => a.localeCompare(b)));
  const nextPt = { ...existingPt, ...sortKeys(mergedExtractedPt) };
  delete nextPt.extracted;
  const nextEn = { ...existingEn, ...sortKeys(mergedExtractedEn) };
  delete nextEn.extracted;

  // Report
  const perFile: Record<string, { count: number; samples: string[] }> = {};
  for (const f of findings) {
    const rel = relWeb(f.file);
    perFile[rel] ??= { count: 0, samples: [] };
    perFile[rel].count += 1;
    if (perFile[rel].samples.length < 3) perFile[rel].samples.push(f.text);
  }
  const totalExtracted = Object.keys(ptMessages).length;
  const totalReplacements = findings.filter((f) => !f.skipped).length;
  const skipped = findings.filter((f) => f.skipped);
  const reportLines = [
    '# i18n Extraction Report',
    '',
    `- Dry run: ${DRY ? 'yes' : 'no'}`,
    `- Files touched: ${touchedFiles.length}`,
    `- Unique PT strings extracted: ${totalExtracted}`,
    `- Raw replacements performed: ${totalReplacements}`,
    `- Non-literal strings surfaced for manual cleanup: ${skipped.length}`,
    '',
    '## Per-file summary',
    '',
    ...Object.entries(perFile)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(
        ([file, { count, samples }]) =>
          `- \`${file}\` — ${count} replacements. e.g. ${samples.map((s) => `"${s}"`).join(', ')}`,
      ),
    '',
    '## Manual cleanup candidates',
    '',
    ...(skipped.length === 0
      ? ['_none_']
      : skipped.map(
          (f) => `- ${markdownCodeSpan(relWeb(f.file))} — ${f.kind}: ${markdownCodeSpan(f.text)}`,
        )),
    '',
  ].join('\n');

  if (DRY) {
    console.log(reportLines);
    console.log('\n--- DRY RUN — no files written ---');
    return;
  }

  // Save source edits
  for (const file of files) {
    await file.save();
  }

  writeFileSync(PT_FILE, `${JSON.stringify(nextPt, null, 2)}\n`, 'utf8');
  writeFileSync(EN_FILE, `${JSON.stringify(nextEn, null, 2)}\n`, 'utf8');

  if (!existsSync(path.dirname(REPORT_PATH)))
    mkdirSync(path.dirname(REPORT_PATH), { recursive: true });
  writeFileSync(REPORT_PATH, reportLines, 'utf8');

  console.log(`Extraction done: ${totalExtracted} strings, ${touchedFiles.length} files touched.`);
  console.log(`Report: ${REPORT_PATH}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
