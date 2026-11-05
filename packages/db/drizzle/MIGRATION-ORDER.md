# Migration Order

This folder has both Drizzle-journaled migrations and manual SQL hardening
migrations. The historical order is not plain filename order: the manual April
migrations predate the journaled June migrations.

## Manual Replay Sequence

For a clean replay, execute the following blocks in order. The CI script
`scripts/check-canonical-sql.sh` codifies this sequence and refuses to run when
the Drizzle journal changes without a corresponding sequence update.

1. Journaled migrations `0000_chief_zemo.sql` through
   `0003_slippery_gorgon.sql`.
2. Manual migrations `0004_triggers_and_rls.sql`,
   `0005_audit_hardening.sql`, and `0007_stream_c_invariants.sql`.
3. Journaled migrations `0004_bright_doctor_octopus.sql` through
   `0008_nebulous_echo.sql` (the latter drops the legacy NOT NULL on
   `user_profiles.password_hash`; it was trimmed of ~30 drift statements the
   generator re-emitted for changes already applied by hand — apply it as the
   single ALTER it contains).
4. The remaining manual migrations:

   1. `0008_materializer_unique.sql`
   2. `0009_domain_type_refund_check.sql`
   3. `0010_fx_rates.sql`
   4. `0011_family_loan_payment_and_receipt_day.sql`
   5. `0012_transactions_billing_month_check.sql`
   6. `0013_rls_complete_policies.sql`
   7. `0014_app_user_role.sql`
   8. `0015_balance_trigger_lock.sql`
   9. `0016_transactions_billing_pair_check.sql`
   10. `0017_fk_indexes.sql`
   11. `0018_user_profiles_updated_at.sql`
   12. `0019_auth_timestamptz.sql`
   13. `0020_fx_rates_history.sql`
   14. `0021_fatura_imports.sql`

       Adds the auditable statement reconciliation draft table, its ownership
       RLS policy, updated-at trigger, indexes, constraints, and `app_user` grant.
   15. `0022_auth_tables_disable_rls.sql`

       Corrects environments where RLS was enabled out-of-band on Better Auth's
       internal tables. Authentication runs before a user-scoped GUC exists, so
       these tables intentionally remain outside application-data RLS.
   16. `0023_user_profiles_rls_empty_guc.sql`

       Makes the Better Auth profile bootstrap safe on transaction-pooler
       connections where a cleared `app.current_user_id` GUC is exposed as an
       empty string instead of `NULL`.
   17. `0024_fatura_match_rules.sql`

       Persists user- and card-scoped statement-description links to active
       fixed-charge schedules, including RLS, trigger, indexes, and `app_user`
       access.

5. Journaled migration `0009_supreme_shard.sql` (S02). Adds optional statement,
   purchase and posting dates with source metadata, import document identity,
   and effective-cycle amount changes. It must follow manual `0021`/`0024`,
   whose existing tables were absent from the previous Drizzle snapshot.
   It does not shift legacy billing periods or change occurrence dates.

6. Journaled migration `0010_exotic_bucky.sql` (S03). Adds optional BRL cash
   settlement amounts/effective dates, explicit provenance, reviewed wallet
   anchor basis, opt-in date assumptions and payroll allocations. Loan payment
   methods remain unclassified until reviewed. Payroll allocation ownership,
   active uniqueness, aggregate bounds and RLS are enforced without rewriting
   existing economic amounts or settlement history.

`0006_domain_type_enum.sql` is intentionally excluded: it was a manual
conversion prepared for the legacy varchar path, but production retained that
path until the journaled `0004_bright_doctor_octopus.sql` performed the enum
conversion.

There is no `0021_currency_homogeneity_guard.sql` in the current state. The
mixed-currency investigation chose the documented warning path instead because
existing USD income rows intentionally flow into BRL wallets and are converted
at read time.

## Operational Notes

- Back up the target database before applying any manual migration.
- Apply `packages/db/src/sql/triggers-and-rls.sql` after a test DB reset; it is
  the canonical idempotent source for functions, triggers, RLS policies, grants,
  and FORCE ROW LEVEL SECURITY.
- Runtime RLS requires the web app to use `APP_DATABASE_URL` for the `app_user`
  role. Superuser URLs are reserved for tooling and tests.

## S03 atomic payroll guards

`0011_payroll_guards.sql` is journaled after `0010_exotic_bucky.sql`. It protects active allocation values and loan bindings; undo first reverses allocations, then restores the occurrence snapshots. No historical rows are changed.

`0012_wallet_cash_selection.sql` follows 0011 in the journal. Canonical cash value/window functions now serve current cash, historical series and the checking balance trigger. Legacy anchors retain the recorded basis; this migration performs no anchor cutover or historical reclassification.

`0013_preserve_ledger_balance.sql` restores economic account balances after the local 0012 experiment. The double-entry ledger continues to sum economic amounts; real cash uses the shared cash functions through WalletCashService. No web reader or export uses accounts.current_balance as available cash. Applied local migrations remain immutable.

## S04 purchase inbox

`0014_cynical_clea.sql` follows S03 in the journal. It adds purchase observations, event identities, immutable revisions and uniquely linked ledger targets. Owner guards, normalized-field allowlisting and runtime RLS apply to all four tables. It performs no backfill or financial writes.

0015_purchase_link_revocation.sql allows revoking an owned immutable link after its financial target was reversed. Reactivating revoked links is forbidden. No financial rows are changed.

0016_purchase_refund_schedule.sql extends owned schedule links to refunds by billing cycle, preserving links across rematerialization. No financial rows are changed.

## S05 capture devices

`0017_legal_joseph.sql` follows the S04 journal entries. It adds hashed one-time pairing codes, revocable device credentials, and bounded ingress counters. Narrow credential-bootstrap functions resolve the owner before RLS context is set; no financial records are created or modified. This journaled migration is distinct from the older manual `0017_fk_indexes.sql`.

## S06 personal integration staging

`0018_blue_dark_phoenix.sql` adds owned connections, account mappings, provider
movement/bill staging and durable jobs. The `integration_scheduler` role has no
financial table grants; restricted functions claim a job and resolve its owner
from an unexpired lease. `app_user` commits owned pages/checkpoints atomically
but cannot manufacture leases. This is distinct from the older manual 0018 file.
No connection, provider subscription, scheduler credential or production job is
activated by this migration.

`0019_parched_stone_men.sql` adds bounded ingress counters and scheduler-only
functions for idempotent webhook receipt and recovery enqueue. Jobs are committed
before acknowledging delivery; these functions never modify the financial ledger.

`0020_fantastic_blur.sql` adds immutable, revocable bank reconciliation allocations
with owned wallet/transaction guards and one active link per wallet leg. A transfer
can be evidenced independently on both owned wallets without creating another
transaction. Balance reference timestamps remain unknown until institution data
explicitly establishes their meaning. No historical balances or payments change.

`0021_tearful_vision.sql` adds an account read revision fence and preserves creation
watermarks in authenticated webhook jobs. It replaces the scheduler-only webhook
function signature while retaining five-argument compatibility through defaults.

`0022_calm_micromax.sql` adds reviewed classification metadata, owned exact-merchant
rules and immutable batch history with explicit undo. It does not classify legacy
rows or modify payments. RLS and reference guards enforce owner boundaries.

S07 budgets: `0023_eminent_wendell_vaughn.sql` adds owned, versioned BRL limits; RLS and category-owner guard. No financial backfill.

S07 alerts: `0024_thankful_the_santerians.sql` adds owned internal alert states, immutable identities and monotonic revisions; no financial writes.

S07 loan evidence: `0025_previous_mandarin.sql` adds optional annual CET and dated payoff quotes, with complete-tuple constraints and separate economic responsibility. Existing interest rates and settlements remain unchanged.

- 0026_sudden_screwball.sql: versioned closing history and shared period mutation barrier; preserves existing closings as legacy revision 0.

- 0027_closing_period_refinements.sql: restrict occurrence links to their own period, preserve guarded account cascades, and require an authenticated owner for app-role period checks.
