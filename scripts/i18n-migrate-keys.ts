#!/usr/bin/env tsx

import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { Project, type SourceFile, SyntaxKind } from 'ts-morph';

const ROOT = path.resolve(process.env.I18N_MIGRATE_ROOT ?? path.join(__dirname, '..'));
const WEB = path.join(ROOT, 'apps', 'web', 'src');
const EN = path.join(WEB, 'i18n', 'messages', 'en.json');
const PT = path.join(WEB, 'i18n', 'messages', 'pt-BR.json');
const HASH = /^[0-9a-f]{6}$/;
const FULL_KEY = /^([a-z0-9-]+)\.([0-9a-f]{6})$/;

type Block = Record<string, string>;
type Messages = Record<string, Block>;
type Plan = {
  namespace: string;
  oldLeaf: string;
  newLeaf: string;
  value: string;
  fullSites: number;
  leafSites: number;
};

function excluded(namespace: string) {
  return (
    namespace === 'app-dashboard-monthly-spending-page' ||
    namespace === 'app-dashboard-monthly-spending-monthlyspendingclient' ||
    namespace.startsWith('components-monthly-spending-')
  );
}

function semanticLeaf(value: string) {
  const words = value
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-zA-Z0-9 ]/g, ' ')
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 4)
    .map((word) => word.toLowerCase());
  const leaf = words
    .map((word, index) => (index === 0 ? word : word[0].toUpperCase() + word.slice(1)))
    .join('');
  return !leaf ? 'label' : HASH.test(leaf) ? `${leaf}Label` : leaf;
}

function readMessages(file: string) {
  return JSON.parse(readFileSync(file, 'utf8')) as Messages;
}

function sourceFiles() {
  const project = new Project({
    tsConfigFilePath: path.join(ROOT, 'apps', 'web', 'tsconfig.json'),
    skipAddingFilesFromTsConfig: true,
  });
  const root = WEB.replace(/\\/g, '/');
  project.addSourceFilesAtPaths([
    `${root}/**/*.ts`,
    `${root}/**/*.tsx`,
    `!${root}/i18n/messages/**`,
  ]);
  return project;
}

function nodeKey(node: { getStart: () => number; getSourceFile: () => SourceFile }) {
  return `${node.getSourceFile().getFilePath()}:${node.getStart()}`;
}

function translationBindings(file: SourceFile) {
  const bindings = new Map<string, string>();
  for (const declaration of file.getDescendantsOfKind(SyntaxKind.VariableDeclaration)) {
    const initializer = declaration.getInitializerIfKind(SyntaxKind.CallExpression);
    if (initializer?.getExpression().getText() !== 'useTranslations') continue;
    const namespace = initializer
      .getArguments()[0]
      ?.asKind(SyntaxKind.StringLiteral)
      ?.getLiteralValue();
    const identifier = declaration.getNameNode().asKind(SyntaxKind.Identifier);
    if (!namespace || !identifier) continue;
    for (const reference of identifier.findReferencesAsNodes())
      bindings.set(nodeKey(reference), namespace);
  }
  return bindings;
}

function main() {
  const dryRun = process.argv.includes('--dry-run');
  const en = readMessages(EN);
  const pt = readMessages(PT);
  const plans = new Map<string, Plan>();

  for (const [namespace, block] of Object.entries(en)) {
    if (excluded(namespace)) continue;
    const used = new Set(Object.keys(block).filter((key) => !HASH.test(key)));
    const plannedByLeaf = new Map<string, Plan>();
    for (const [oldLeaf, value] of Object.entries(block)) {
      if (!HASH.test(oldLeaf)) continue;
      const base = semanticLeaf(value);
      const matching = plannedByLeaf.get(base);
      if (matching?.value === value) {
        plans.set(`${namespace}.${oldLeaf}`, { ...matching, oldLeaf });
        continue;
      }
      let newLeaf = base;
      let suffix = 2;
      while (used.has(newLeaf) || plannedByLeaf.has(newLeaf)) newLeaf = `${base}${suffix++}`;
      used.add(newLeaf);
      const plan = { namespace, oldLeaf, newLeaf, value, fullSites: 0, leafSites: 0 };
      plannedByLeaf.set(newLeaf, plan);
      plans.set(`${namespace}.${oldLeaf}`, plan);
    }
  }

  const project = sourceFiles();
  type Site = { plan: Plan; type: 'full' | 'leaf'; set: (value: string) => void };
  const sites: Site[] = [];

  for (const file of project.getSourceFiles()) {
    const bindings = translationBindings(file);

    for (const literal of file.getDescendantsOfKind(SyntaxKind.StringLiteral)) {
      const value = literal.getLiteralValue();
      if (FULL_KEY.test(value)) {
        const plan = plans.get(value);
        if (plan) {
          plan.fullSites += 1;
          sites.push({ plan, type: 'full', set: (target) => literal.setLiteralValue(target) });
        }
        continue;
      }
      if (!HASH.test(value)) continue;
      const call = literal.getParentIfKind(SyntaxKind.CallExpression);
      const expression = call?.getExpression().asKind(SyntaxKind.Identifier);
      const namespace = expression ? bindings.get(nodeKey(expression)) : undefined;
      const plan = namespace ? plans.get(`${namespace}.${value}`) : undefined;
      if (plan) {
        plan.leafSites += 1;
        sites.push({ plan, type: 'leaf', set: (target) => literal.setLiteralValue(target) });
      }
    }
  }

  const uniquePlans = [...new Set(plans.values())];
  console.log(`hash keys planned: ${uniquePlans.length}`);
  for (const plan of uniquePlans) {
    const used = plan.fullSites + plan.leafSites;
    console.log(
      `  ${plan.namespace}.${plan.oldLeaf} -> ${used ? `${plan.namespace}.${plan.newLeaf}` : '(DELETE, unused)'}`,
    );
  }
  if (dryRun) {
    console.log('--dry-run: nothing written.');
    return;
  }

  for (const site of sites) {
    site.set(
      site.type === 'full' ? `${site.plan.namespace}.${site.plan.newLeaf}` : site.plan.newLeaf,
    );
  }
  project.saveSync();

  function rewrite(messages: Messages): Messages {
    const output: Messages = {};
    for (const [namespace, block] of Object.entries(messages)) {
      if (excluded(namespace)) {
        output[namespace] = block;
        continue;
      }
      const next: Block = {};
      for (const [oldLeaf, value] of Object.entries(block)) {
        const plan = plans.get(`${namespace}.${oldLeaf}`);
        if (!plan) next[oldLeaf] = value;
        else if (plan.fullSites + plan.leafSites > 0 && !(plan.newLeaf in next)) {
          next[plan.newLeaf] = value;
        }
      }
      if (Object.keys(next).length) output[namespace] = next;
    }
    return output;
  }

  writeFileSync(EN, `${JSON.stringify(rewrite(en), null, 2)}\n`);
  writeFileSync(PT, `${JSON.stringify(rewrite(pt), null, 2)}\n`);
  console.log(`call sites rewritten: ${sites.length}`);
}

main();
