-- Manual migration: materializer self-duplication backstop.
-- Applied: 2026-06-01
--
-- Adds a partial UNIQUE index so concurrent / racing materializer runs cannot
-- insert two schedule-linked rows for the same (schedule, date). A schedule
-- produces at most one non-reversed occurrence per calendar date
-- (computeOccurrenceDates never emits two same-date occurrences), so this index
-- is gap-safe. Combined with .onConflictDoNothing() in MaterializerService and
-- run-materializer, plus the per-user pg_advisory_xact_lock in
-- MaterializationGuard, materialization becomes idempotent under concurrency.
--
-- Manual reconciliation rows (scheduled_transaction_id IS NULL) are excluded by
-- the partial predicate; those are deduped in-application by content key.
--
-- Pre-flight: 0 violating (scheduled_transaction_id, date) groups confirmed on
-- the primary DB (sql/29 cleanup removed all self-duplicates first).

DO $$
DECLARE v_violations int;
BEGIN
  SELECT count(*) INTO v_violations FROM (
    SELECT scheduled_transaction_id, date
    FROM transactions
    WHERE scheduled_transaction_id IS NOT NULL AND is_reversed = false
    GROUP BY scheduled_transaction_id, date
    HAVING count(*) > 1
  ) s;
  IF v_violations <> 0 THEN
    RAISE EXCEPTION 'Cannot create tx_materialized_unique: % violating group(s) exist; clean duplicates first', v_violations;
  END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS tx_materialized_unique
  ON transactions (scheduled_transaction_id, date)
  WHERE scheduled_transaction_id IS NOT NULL AND is_reversed = false;
