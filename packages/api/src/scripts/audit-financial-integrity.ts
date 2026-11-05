import { parseArgs } from 'node:util';
import { accounts, createDb } from '@fc/db';
import { and, eq } from 'drizzle-orm';
import { resolveDatabaseTarget } from '../../../../scripts/lib/database-target.ts';
import {
  auditFinancialIntegrity,
  financialManifestHash,
  repairScopeSchema,
} from '../services/financial-repair.service.ts';
import {
  auditPayrollIntegrity,
  payrollAuditScopeSchema,
} from '../services/payroll-repair-audit.service.ts';
import { auditStatementIntegrity } from '../services/statement-repair.service.ts';
import {
  financialRepairRoot,
  reportRepairFailure,
  writePrivateRepairFile,
} from './financial-repair-files.ts';

async function main() {
  const root = financialRepairRoot();
  const { values } = parseArgs({
    options: {
      cycles: { type: 'boolean' },
      payroll: { type: 'boolean' },
      loans: { type: 'string' },
      user: { type: 'string' },
      cards: { type: 'string' },
      from: { type: 'string' },
      to: { type: 'string' },
    },
  });
  if (!values.user || (!values.payroll && !values.cards) || !values.from || !values.to)
    throw new Error('REPAIR_EXPLICIT_SCOPE_REQUIRED');
  const target = resolveDatabaseTarget(process.env);
  const db = createDb(target.migration.url);
  try {
    if (values.payroll) {
      if (values.cycles || values.cards || !values.loans)
        throw new Error('REPAIR_EXPLICIT_SCOPE_REQUIRED');
      const scope = payrollAuditScopeSchema.parse({
        userId: values.user,
        loanAccountIds: values.loans.split(','),
        fromPeriod: values.from,
        toPeriod: values.to,
      });
      const manifest = await auditPayrollIntegrity(db, scope, target.fingerprint);
      const file = await writePrivateRepairFile(
        root,
        manifest.id,
        'payroll-diagnosis.json',
        manifest,
      );
      process.stdout.write(
        `${JSON.stringify({ file, hash: financialManifestHash(manifest), target: target.fingerprint, status: manifest.status, executable: false, contracts: manifest.loans.length, occurrences: manifest.occurrences.length })}\n`,
      );
      return;
    }
    if (!values.cards) throw new Error('REPAIR_EXPLICIT_SCOPE_REQUIRED');
    const cardAccountIds =
      values.cards === 'all'
        ? (
            await db
              .select({ id: accounts.id })
              .from(accounts)
              .where(and(eq(accounts.userId, values.user), eq(accounts.type, 'credit_card')))
          ).map((a) => a.id)
        : values.cards.split(',');
    const scope = repairScopeSchema.parse({
      userId: values.user,
      cardAccountIds,
      fromPeriod: values.from,
      toPeriod: values.to,
    });
    const manifest = values.cycles
      ? await auditStatementIntegrity(db, scope, target.fingerprint)
      : await auditFinancialIntegrity(db, scope, target.fingerprint);
    const file = await writePrivateRepairFile(root, manifest.id, 'manifest-draft.json', manifest);
    process.stdout.write(
      `${JSON.stringify({ file, hash: financialManifestHash(manifest), target: target.fingerprint, status: manifest.status, candidates: 'kind' in manifest ? manifest.groups.filter((g) => g.importIds.length === 1).length : manifest.entries.filter((e) => e.decision === 'pending').length, excluded: 'kind' in manifest ? manifest.groups.filter((g) => g.reasons.length > 0).length : manifest.entries.filter((e) => e.decision === 'exclude').length })}\n`,
    );
  } finally {
    await db.$client.end();
  }
}
main().catch(reportRepairFailure);
