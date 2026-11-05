# @fc/db

Drizzle ORM schema and migrations for the financial-control-v2 monorepo.

- Schema: `src/schema/`
- Migrations: `drizzle/`
- Config: `drizzle.config.ts` (loads `../../.env`)

## Migration workflow

Use the workflow documented in the project root `CLAUDE.md`:

1. Edit schema in `src/schema/`
2. `pnpm db:generate`
3. Review SQL in `drizzle/`
4. `pnpm db:safe-migrate` (backs up + applies)

NEVER use `drizzle-kit push` directly on a non-test database.

## Test DB reset

Use `pnpm test:db:reset --confirm` (from monorepo root) to restore the test
database (`financial_control_v2_test`) to a clean schema state matching
Drizzle. Useful when the test DB drifts (missing functions, columns, or
manual SQL applied during test development).

What it does:
1. Backs up the current test DB to `backups/test-db-reset-<timestamp>.dump`.
2. `DROP SCHEMA public CASCADE; CREATE SCHEMA public` (test DB only).
3. `drizzle-kit push --force` to recreate all schema-derived objects
   (tables, columns, CHECK constraints, FKs, the `domain_type` enum,
   partial unique indexes).
4. Applies `packages/db/src/sql/triggers-and-rls.sql` — the **single
   source of truth** for non-DDL database objects that Drizzle does not
   own:
   - plpgsql functions (`recalculate_account_balance`,
     `trigger_set_updated_at`, `trigger_recalculate_balance`).
   - `updated_at` and balance-recalculation triggers.
   - `ENABLE ROW LEVEL SECURITY` and per-table RLS policies.

   The file is idempotent (`CREATE OR REPLACE FUNCTION`,
   `DROP TRIGGER IF EXISTS … CREATE`, `DROP POLICY IF EXISTS … CREATE`)
   so it can be re-run safely.

## Canonical triggers/RLS rule

**`packages/db/src/sql/triggers-and-rls.sql` is the single source of truth**
for plpgsql functions, triggers, and RLS policies. Historical migrations
(e.g., `drizzle/0004_triggers_and_rls.sql`) are frozen and should not be
modified.

When you need to add or change a trigger, function, or RLS policy:
1. Write a new migration (`pnpm db:generate` or a hand-written SQL file
   under `drizzle/`) that captures the delta for production replay.
2. **Update `packages/db/src/sql/triggers-and-rls.sql`** to reflect the
   new end state. Both files change in the same commit.
3. Test locally: `pnpm test:db:reset --confirm` should produce the same
   object set that a full migration chain replay would produce.

Rationale: prod DBs use the migration chain; test DB uses
`drizzle-kit push + canonical SQL`. Without the canonical file, test DB
and prod DB drift. Without the migration, prod DB never sees the change.

Safety:
- Refuses to run unless the database name ends in `_test`.
- Requires the explicit `--confirm` flag.
- Resolves the target DB from `DATABASE_URL` first, then `TEST_DATABASE_URL`,
  then `TEST_DATABASE_URL` parsed from `.env`.

Examples:

```bash
# Standard usage (resolves test DB from .env):
pnpm test:db:reset --confirm

# Explicit URL:
DATABASE_URL=postgresql://postgres:postgres@localhost:5433/financial_control_v2_test \
  pnpm test:db:reset --confirm

# Verify dry-run / safety:
pnpm test:db:reset                          # aborts: --confirm required
DATABASE_URL=postgresql://...financial_control_v2 pnpm test:db:reset --confirm
                                            # aborts: name does not end in _test
```

After reset:
```bash
pnpm --filter @fc/api test
```
