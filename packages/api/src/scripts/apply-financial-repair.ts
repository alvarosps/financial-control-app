import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import { createDb } from '@fc/db';
import { z } from 'zod';
import { createVerifiedBackup } from '../../../../scripts/lib/database-maintenance.ts';
import { resolveDatabaseTarget } from '../../../../scripts/lib/database-target.ts';
import {
  createFinancialRepairInverse,
  FinancialRepairService,
  financialManifestHash,
  financialManifestSchema,
  reviewFinancialManifest,
  reviewFinancialRepairInverse,
  validateFinancialRepairRequest,
} from '../services/financial-repair.service.ts';
import {
  createStatementInverse,
  reviewStatementInverse,
  reviewStatementManifest,
  StatementRepairService,
  statementManifestSchema,
  validateStatementRepairRequest,
} from '../services/statement-repair.service.ts';
import {
  financialRepairRoot,
  reportRepairFailure,
  writePrivateRepairFile,
} from './financial-repair-files.ts';

async function jsonFile(path: string) {
  return JSON.parse(await readFile(path, 'utf8')) as unknown;
}

async function main() {
  const root = financialRepairRoot();
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      manifest: { type: 'string' },
      evidence: { type: 'string' },
      reviewer: { type: 'string' },
      hash: { type: 'string' },
      'confirm-target': { type: 'string' },
      user: { type: 'string' },
      from: { type: 'string' },
      to: { type: 'string' },
      apply: { type: 'boolean' },
      'producers-paused': { type: 'boolean' },
      inverse: { type: 'string' },
      'inverse-hash': { type: 'string' },
    },
  });
  const mode = positionals[0] ?? 'preview';
  if (
    positionals.length > 1 ||
    !['preview', 'review', 'apply', 'review-inverse', 'revert'].includes(mode)
  )
    throw new Error('REPAIR_MODE_INVALID');
  if (mode === 'review-inverse') {
    if (!values.inverse || !values.reviewer) throw new Error('REPAIR_REVIEW_INPUT_REQUIRED');
    const rawInverse = await jsonFile(values.inverse);
    const inverse =
      typeof rawInverse === 'object' &&
      rawInverse !== null &&
      'kind' in rawInverse &&
      rawInverse.kind === 'statement-cycles'
        ? reviewStatementInverse(rawInverse, values.reviewer)
        : reviewFinancialRepairInverse(rawInverse, values.reviewer);
    const file = await writePrivateRepairFile(root, randomUUID(), 'inverse-reviewed.json', inverse);
    process.stdout.write(
      `${JSON.stringify({ file, hash: financialManifestHash(inverse), status: inverse.status })}\n`,
    );
    return;
  }
  if (!values.manifest) throw new Error('REPAIR_MANIFEST_REQUIRED');
  const manifest = z
    .union([statementManifestSchema, financialManifestSchema])
    .parse(await jsonFile(values.manifest));
  if (mode === 'review') {
    if (!values.evidence || !values.reviewer) throw new Error('REPAIR_REVIEW_INPUT_REQUIRED');
    const evidence = await jsonFile(values.evidence);
    if (!Array.isArray(evidence)) throw new Error('REPAIR_EVIDENCE_REQUIRED');
    const reviewed =
      'kind' in manifest
        ? reviewStatementManifest(manifest, evidence, values.reviewer)
        : reviewFinancialManifest(manifest, evidence, values.reviewer);
    const file = await writePrivateRepairFile(
      root,
      randomUUID(),
      'manifest-reviewed.json',
      reviewed,
    );
    process.stdout.write(
      `${JSON.stringify({ file, hash: financialManifestHash(reviewed), operations: 'kind' in reviewed ? reviewed.evidence.length : reviewed.entries.filter((e) => e.decision === 'apply').length })}\n`,
    );
    return;
  }
  const target = resolveDatabaseTarget(process.env);
  if (manifest.target !== target.fingerprint) throw new Error('REPAIR_TARGET_MISMATCH');
  if (mode === 'preview' || !values.apply) {
    process.stdout.write(
      `${JSON.stringify({ status: 'preview', target: target.fingerprint, manifestHash: financialManifestHash(manifest), manifestFile: values.manifest, approved: 'kind' in manifest ? manifest.evidence.length : manifest.entries.filter((e) => e.decision === 'apply').length, pending: 'kind' in manifest ? manifest.groups.length - manifest.evidence.length : manifest.entries.filter((e) => e.decision === 'pending').length, databaseChanged: false })}\n`,
    );
    return;
  }
  if (!values.hash || !values['confirm-target'] || !values.user || !values.from || !values.to)
    throw new Error('REPAIR_EXPLICIT_SCOPE_REQUIRED');
  const request = {
    targetFingerprint: target.fingerprint,
    confirmTarget: values['confirm-target'],
    expectedManifestHash: values.hash,
    userId: values.user,
    fromPeriod: values.from,
    toPeriod: values.to,
    producersPaused: values['producers-paused'] === true,
  };
  if ('kind' in manifest) validateStatementRepairRequest(manifest, request);
  else validateFinancialRepairRequest(manifest, request);
  const inverse = mode === 'revert' && values.inverse ? await jsonFile(values.inverse) : null;
  if (
    mode === 'revert' &&
    (!inverse ||
      !values['inverse-hash'] ||
      financialManifestHash(inverse) !== values['inverse-hash'])
  )
    throw new Error('REPAIR_INVERSE_REVIEW_REQUIRED');
  const runId = randomUUID();
  await writePrivateRepairFile(root, runId, 'request.json', {
    mode,
    ...request,
    manifestId: manifest.id,
  });
  const backup = await createVerifiedBackup({ root, env: process.env, target });
  await writePrivateRepairFile(root, runId, 'backup.json', backup);
  const db = createDb(target.migration.url);
  try {
    const service =
      'kind' in manifest ? new StatementRepairService(db) : new FinancialRepairService(db);
    const safety = { ...request, backup };
    const result =
      mode === 'revert'
        ? await service.revert(manifest, inverse, {
            ...safety,
            expectedInverseHash: values['inverse-hash'] ?? '',
          })
        : await service.apply(manifest, safety);
    try {
      const file = await writePrivateRepairFile(root, runId, 'receipt.json', result.receipt);
      const inverseFile =
        mode === 'apply'
          ? await writePrivateRepairFile(
              root,
              runId,
              'inverse-draft.json',
              'kind' in manifest
                ? createStatementInverse(result.receipt)
                : createFinancialRepairInverse(result.receipt),
            )
          : undefined;
      process.stdout.write(
        `${JSON.stringify({ status: result.status, file, inverseFile, receiptHash: financialManifestHash(result.receipt) })}\n`,
      );
    } catch {
      throw new Error('REPAIR_COMMITTED_RECEIPT_EXPORT_FAILED');
    }
  } finally {
    await db.$client.end();
  }
}

main().catch(reportRepairFailure);
