import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { maintainDatabase } from './lib/database-maintenance.ts';
import { resolveDatabaseTarget } from './lib/database-target.ts';

async function main() {
  let root = resolve(process.cwd());
  while (!existsSync(join(root, 'pnpm-workspace.yaml'))) {
    const parent = dirname(root);
    if (parent === root) throw new Error('DATABASE_REPOSITORY_ROOT_REQUIRED');
    root = parent;
  }
  if (existsSync(join(root, '.env'))) process.loadEnvFile(join(root, '.env'));
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      'dry-run': { type: 'boolean' },
      apply: { type: 'boolean' },
      'confirm-target': { type: 'string' },
      baseline: { type: 'string' },
    },
  });
  const mode = positionals[0];
  if (positionals.length !== 1 || !['backup', 'migrate', 'inspect'].includes(mode))
    throw new Error(
      'DATABASE_USAGE: backup|migrate|inspect [--dry-run] [--apply --confirm-target fingerprint --baseline file]',
    );
  const result = await maintainDatabase({
    root,
    env: process.env,
    target: resolveDatabaseTarget(process.env),
    mode: mode as 'backup' | 'migrate' | 'inspect',
    dryRun: values['dry-run'],
    apply: values.apply,
    confirmTarget: values['confirm-target'],
    baseline: values.baseline,
  });
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

main().catch((error: unknown) => {
  const message =
    error instanceof Error && error.message.startsWith('DATABASE_')
      ? error.message
      : 'DATABASE_MAINTENANCE_FAILED';
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
});
