import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import { createDb } from '@fc/db';
import { sql } from 'drizzle-orm';
import { createVerifiedBackup } from '../../../../scripts/lib/database-maintenance.ts';
import { resolveDatabaseTarget } from '../../../../scripts/lib/database-target.ts';
import {
  HistoricalSettlementService,
  historicalInverseSchema,
  historicalSettlementManifestSchema,
  historicalSettlementRequestSchema,
} from '../services/historical-settlement.service.ts';
import { financialRepairRoot, writePrivateRepairFile } from './financial-repair-files.ts';

async function main() {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      file: { type: 'string' },
      hash: { type: 'string' },
      'confirm-target': { type: 'string' },
      'producers-paused': { type: 'boolean' },
    },
  });
  const mode = positionals[0] ?? 'preview';
  if (
    positionals.length > 1 ||
    !['preview', 'apply', 'preview-inverse', 'revert'].includes(mode) ||
    !values.file
  )
    throw new Error('HISTORICAL_INPUT_REQUIRED');
  const root = financialRepairRoot();
  const target = resolveDatabaseTarget(process.env);
  const raw: unknown = JSON.parse(await readFile(values.file, 'utf8'));
  const runId = randomUUID();
  const mutation = mode === 'apply' || mode === 'revert';
  // All explicit checks precede backup or database mutation.
  const reviewed =
    mode === 'revert'
      ? historicalInverseSchema.parse(raw)
      : mode === 'preview'
        ? null
        : historicalSettlementManifestSchema.parse(raw);
  if (reviewed && reviewed.target !== target.fingerprint)
    throw new Error('HISTORICAL_TARGET_MISMATCH');
  if (
    mutation &&
    (!reviewed ||
      values.hash !== reviewed.hash ||
      values['confirm-target'] !== target.fingerprint ||
      !values['producers-paused'])
  )
    throw new Error('HISTORICAL_REVIEW_REQUIRED');
  const backup = mutation ? await createVerifiedBackup({ root, env: process.env, target }) : null;
  if (backup) await writePrivateRepairFile(root, runId, 'backup.json', backup);
  const db = createDb(target.migration.url);
  try {
    let result: unknown;
    if (!mutation) {
      result = await db.transaction(async (tx) => {
        await tx.execute(sql`SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY`);
        const service = new HistoricalSettlementService(tx);
        return mode === 'preview'
          ? service.preview(historicalSettlementRequestSchema.parse(raw), target.fingerprint)
          : service.previewInverse(raw);
      });
    } else {
      if (!backup) throw new Error('HISTORICAL_BACKUP_REQUIRED');
      const safety = {
        target: target.fingerprint,
        confirmTarget: values['confirm-target'] ?? '',
        expectedHash: values.hash ?? '',
        producersPaused: values['producers-paused'] === true,
        backup,
      };
      const service = new HistoricalSettlementService(db);
      result =
        mode === 'apply' ? await service.apply(raw, safety) : await service.revert(raw, safety);
    }
    const file = await writePrivateRepairFile(
      root,
      runId,
      mutation ? 'receipt.json' : 'manifest.json',
      result,
    );
    process.stdout.write(
      `${JSON.stringify({ mode, file, target: target.fingerprint, databaseChanged: mutation })}\n`,
    );
  } finally {
    await db.$client.end();
  }
}
main().catch((error: unknown) => {
  process.stderr.write(
    `${error instanceof Error && /^(HISTORICAL_|DATABASE_)[A-Z_]+$/.test(error.message) ? error.message : 'HISTORICAL_OPERATION_FAILED'}\n`,
  );
  process.exitCode = 1;
});
