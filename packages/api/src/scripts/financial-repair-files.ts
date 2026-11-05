import { existsSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';

export function financialRepairRoot(): string {
  let root = resolve(process.cwd());
  while (!existsSync(join(root, 'pnpm-workspace.yaml'))) {
    const parent = dirname(root);
    if (parent === root) throw new Error('REPAIR_REPOSITORY_ROOT_REQUIRED');
    root = parent;
  }
  if (existsSync(join(root, '.env'))) process.loadEnvFile(join(root, '.env'));
  return root;
}

export async function writePrivateRepairFile(
  root: string,
  runId: string,
  name: string,
  data: unknown,
) {
  if (!/^[a-f0-9-]{36}$/.test(runId) || !/^[a-z-]+\.json$/.test(name))
    throw new Error('REPAIR_OUTPUT_PATH_INVALID');
  const directory = join(root, 'scratch/financial-repair', runId);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const file = join(directory, name);
  await writeFile(file, `${JSON.stringify(data, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
  return file;
}

export function reportRepairFailure(error: unknown) {
  const message =
    error instanceof Error && /^(REPAIR_|DATABASE_)[A-Z_]+$/.test(error.message)
      ? error.message
      : 'REPAIR_OPERATION_FAILED';
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
}
