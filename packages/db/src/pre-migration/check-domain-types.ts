/**
 * Pre-migration check for the `domainTypeEnum` migration.
 *
 * Queries distinct `domain_type` values from `transactions` and
 * `scheduled_transactions` and fails if any value is missing from the
 * canonical `DOMAIN_TYPES` literal array in `@fc/shared`. Missing values
 * indicate a data drift that would break the `CREATE TYPE domain_type AS
 * ENUM(...)` migration and must be resolved before applying the forward
 * migration.
 *
 * Usage: pnpm --filter @fc/db pre-migrate:domain-types
 *        DATABASE_URL=... pnpm --filter @fc/db pre-migrate:domain-types
 */
import 'dotenv/config';
import { DOMAIN_TYPES } from '@fc/shared';
import { sql } from 'drizzle-orm';
import { createDb } from '../client.ts';

type DomainRow = { domain_type: string | null };

async function main(): Promise<void> {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL is required.');
  const db = createDb(url);

  const allowed = new Set<string>(DOMAIN_TYPES);

  const rows = await db.execute<DomainRow>(sql`
    SELECT DISTINCT domain_type
      FROM transactions
     WHERE domain_type IS NOT NULL
    UNION
    SELECT DISTINCT domain_type
      FROM scheduled_transactions
     WHERE domain_type IS NOT NULL
  `);

  const existing = rows
    .map((r) => r.domain_type)
    .filter((v): v is string => typeof v === 'string' && v.length > 0);
  const unknown = existing.filter((v) => !allowed.has(v));

  if (unknown.length > 0) {
    console.error('PRE-MIGRATION CHECK FAILED — unknown domain_type values:');
    for (const v of unknown) console.error(`  - ${v}`);
    console.error('Add these values to DOMAIN_TYPES in packages/shared/src/enums.ts');
    console.error('or clean up the offending rows before applying the migration.');
    process.exit(1);
  }

  console.log(`OK: ${existing.length} distinct domain_type value(s), all covered by enum.`);
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(2);
});
