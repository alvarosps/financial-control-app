import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const temporaryRoots: string[] = [];

function fixture() {
  const root = mkdtempSync(path.join(os.tmpdir(), 'i18n-migrate-'));
  temporaryRoots.push(root);
  const source = path.join(root, 'apps', 'web', 'src', 'feature');
  const messages = path.join(root, 'apps', 'web', 'src', 'i18n', 'messages');
  mkdirSync(source, { recursive: true });
  mkdirSync(messages, { recursive: true });
  writeFileSync(path.join(root, 'apps', 'web', 'tsconfig.json'), '{"compilerOptions":{}}');
  writeFileSync(
    path.join(messages, 'en.json'),
    JSON.stringify({ 'feature-dialog': { abc123: 'Save item' } }),
  );
  writeFileSync(
    path.join(messages, 'pt-BR.json'),
    JSON.stringify({ 'feature-dialog': { abc123: 'Salvar item' } }),
  );
  writeFileSync(
    path.join(source, 'Dialog.tsx'),
    [
      "const t = useTranslations('feature-dialog');",
      "const translated = t('abc123');",
      "const full = t('feature-dialog.abc123');",
      "const config = { labelKey: 'feature-dialog.abc123' };",
      'const logger = { t: (key: string) => key };',
      "const logged = logger.t('abc123');",
      "const technical = 'abc123';",
    ].join('\n'),
  );
  return root;
}

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('i18n-migrate-keys', () => {
  it('rewrites translation bindings and full keys while preserving unrelated leaf literals', () => {
    const root = fixture();
    const repository = path.resolve(__dirname, '../../../../../');
    const command = process.platform === 'win32' ? (process.env.ComSpec ?? 'cmd.exe') : 'pnpm';
    const args =
      process.platform === 'win32'
        ? ['/d', '/s', '/c', 'pnpm tsx scripts/i18n-migrate-keys.ts']
        : ['tsx', 'scripts/i18n-migrate-keys.ts'];
    execFileSync(command, args, {
      cwd: repository,
      env: { ...process.env, I18N_MIGRATE_ROOT: root },
    });
    const source = readFileSync(
      path.join(root, 'apps', 'web', 'src', 'feature', 'Dialog.tsx'),
      'utf8',
    );
    expect(source).toContain("t('saveItem')");
    expect(source).toContain("t('feature-dialog.saveItem')");
    expect(source).toContain("labelKey: 'feature-dialog.saveItem'");
    expect(source).toContain("logger.t('abc123')");
    expect(source).toContain("const technical = 'abc123'");
  }, 20000);
});
