import { userProfiles } from '@fc/db';
import { sql } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { withRollback } from '../test/with-rollback.ts';

/**
 * Introspection tests for the RLS posture of the TEST database.
 * The test DB converges via `pnpm test:db:reset --confirm`, which applies
 * packages/db/src/sql/triggers-and-rls.sql (the canonical source of truth).
 * If these fail after editing the canonical file, re-run the reset.
 */
const RLS_TABLES: string[] = [
  'accounts',
  'transactions',
  'scheduled_transactions',
  'categories',
  'credit_card_bills',
  'month_closings',
  'audit_log',
  'simulation_scenarios',
  'materialization_status',
  'account_balance_snapshots',
  'user_profiles',
  'account_shares',
  'credit_card_configs',
  'loan_configs',
  'family_loan_configs',
  'borrowed_cards',
  'income_source_configs',
];
const rlsTableNames = sql.join(
  RLS_TABLES.map((table) => sql`${table}`),
  sql`, `,
);

describe('RLS policies (canonical SQL convergence)', () => {
  it('has ROW LEVEL SECURITY enabled on every user-data table', async () => {
    await withRollback(async (db) => {
      const rows = await db.execute(sql`
        SELECT c.relname
        FROM pg_class c
        JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'public'
          AND c.relname IN (${rlsTableNames})
          AND c.relrowsecurity = true
      `);
      expect(rows.length).toBe(RLS_TABLES.length);
    });
  });

  it('has at least one policy on every user-data table', async () => {
    await withRollback(async (db) => {
      const rows = await db.execute(sql`
        SELECT DISTINCT tablename FROM pg_policies WHERE schemaname = 'public'
      `);
      const names = rows.map((r) => r.tablename);
      for (const table of RLS_TABLES) {
        expect(names).toContain(table);
      }
    });
  });

  it('has NO allow-all (USING true) policies left', async () => {
    await withRollback(async (db) => {
      const rows = await db.execute(sql`
        SELECT policyname FROM pg_policies
        WHERE schemaname = 'public' AND (qual = 'true' OR policyname LIKE '%allow_all%')
      `);
      expect(rows.length).toBe(0);
    });
  });

  it('audit_log policy has an explicit WITH CHECK', async () => {
    await withRollback(async (db) => {
      const rows = await db.execute(sql`
        SELECT with_check FROM pg_policies
        WHERE schemaname = 'public' AND tablename = 'audit_log'
          AND policyname = 'audit_log_user_isolation'
      `);
      expect(rows.length).toBe(1);
      expect(rows[0]?.with_check).not.toBeNull();
    });
  });

  it('app_user role exists and is not superuser / does not bypass RLS', async () => {
    await withRollback(async (db) => {
      const rows = await db.execute(sql`
        SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = 'app_user'
      `);
      expect(rows.length).toBe(1);
      expect(rows[0]?.rolsuper).toBe(false);
      expect(rows[0]?.rolbypassrls).toBe(false);
    });
  });

  it('every RLS table has FORCE ROW LEVEL SECURITY', async () => {
    await withRollback(async (db) => {
      const rows = await db.execute(sql`
        SELECT c.relname
        FROM pg_class c
        JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'public'
          AND c.relname IN (${rlsTableNames})
          AND c.relforcerowsecurity = true
      `);
      expect(rows.length).toBe(RLS_TABLES.length);
    });
  });

  it('resolves user_profiles by auth id when the pooled user GUC was cleared', async () => {
    await withRollback(async (db) => {
      const authUserId = crypto.randomUUID();
      const [profile] = await db
        .insert(userProfiles)
        .values({
          email: `rls-bootstrap-${authUserId}@test.com`,
          name: 'RLS bootstrap',
          authUserId,
        })
        .returning({ id: userProfiles.id });

      await db.execute(sql`SET LOCAL ROLE app_user`);
      await db.execute(sql`SELECT set_config('app.current_user_id', '', true)`);
      await db.execute(sql`SELECT set_config('app.current_auth_user_id', ${authUserId}, true)`);

      const rows = await db.execute(sql`
        SELECT id
        FROM user_profiles
        WHERE auth_user_id = ${authUserId}
      `);

      expect(rows).toEqual([{ id: profile?.id }]);
    });
  });

  it('recalculate_account_balance locks the account row before computing SUMs', async () => {
    await withRollback(async (db) => {
      const rows = await db.execute(sql`
        SELECT pg_get_functiondef('recalculate_account_balance(uuid)'::regprocedure) AS def
      `);
      expect(String(rows[0]?.def)).toContain('FOR UPDATE');
    });
  });

  it('FK support indexes exist', async () => {
    await withRollback(async (db) => {
      const rows = await db.execute(sql`
        SELECT indexname FROM pg_indexes
        WHERE schemaname = 'public'
          AND indexname IN ('tx_category_idx', 'tx_paid_from_idx', 'st_category_idx')
      `);
      expect(rows.length).toBe(3);
    });
  });

  it('user_profiles has the updated_at trigger', async () => {
    await withRollback(async (db) => {
      const rows = await db.execute(sql`
        SELECT tgname FROM pg_trigger
        WHERE tgrelid = 'user_profiles'::regclass
          AND tgname = 'trg_updated_at_user_profiles'
      `);
      expect(rows.length).toBe(1);
    });
  });

  it('better-auth tables use timestamptz everywhere', async () => {
    await withRollback(async (db) => {
      const rows = await db.execute(sql`
        SELECT table_name, column_name FROM information_schema.columns
        WHERE table_schema = 'public'
          AND table_name IN ('user', 'session', 'account', 'verification')
          AND data_type = 'timestamp without time zone'
      `);
      expect(rows.length).toBe(0);
    });
  });
});
