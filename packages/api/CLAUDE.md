# @fc/api

tRPC services + routers for the financial-control-v2 backend.

## Test Mocking Policy

Mocks are only allowed at external boundaries:

- Outgoing HTTP (msw / undici mock)
- PDF parsing fixtures
- Clock (`vi.useFakeTimers`)
- Filesystem (memfs)

Do NOT mock internal classes: services, repositories, mappers, domain
objects. Tests that need to exercise multi-service interactions MUST use
`withRollback` (see `src/test/with-rollback.ts`) with the real test
database.

Rationale: mocking internal collaborators hides integration bugs (past
incidents in this repo proved this — several "passing" unit tests shipped
features that broke the moment a sibling service received real input).

## Running backend tests

- Tests require an explicitly selected local database whose name ends in `_test`
  (normally `financial_control_v2_test`). Development and remote databases are rejected.
- Set `TEST_DATABASE_URL`, `DATABASE_URL_TEST` and `DATABASE_URL` to the same test
  target. If `APP_DATABASE_URL` is present, it must identify that same database
  using the `app_user` role. Conflicting aliases are rejected at startup.
- Use `withRollback` for service tests. Concurrent connections require committed
  synthetic fixtures and cleanup scoped to their generated user IDs.

```bash
pnpm --filter @fc/api test
pnpm --filter @fc/api test --sequence.shuffle  # randomize ordering
```

## Credit-card fatura due dates — real calendar placement

Faturas use the **institution's persisted closing/due dates first**. The pure
`resolveStatementCycle` helper in `packages/domain/src/billing-period.ts` accepts
an explicit `closing` or `due` source reference and resolves the canonical
closing month. Actual dates override current card settings; contradictory
references or impossible dates are rejected. Missing dates remain null, never
an invented day 1. Fixed-day fallback is visibly estimated and requires review
at import; it must not overwrite institution-confirmed dates.

`computeFaturaDueDate` is the legacy fixed-day fallback. Its rule:
when `dueDay <= closingDay`, the fatura is due in the month **after** its
`billingMonth`; otherwise it is due in the same month. For example, a June
fatura (`billingMonth=6`) with `closingDay=15, dueDay=5` is due on
`2026-07-05`, while `closingDay=15, dueDay=25` is due on `2026-06-25`.

This is applied consistently across:
- `getBillSummary` — per-card `currentBill.dueDate` (YYYY-MM-DD string)
- `getBillForMonth` — same `dueDate` field
- `getBill` — `dueDate` field added to the single-month bill return
- `getUpcomingItems` / `getDailyControl` — fatura items land on `dueDate`
- The credit-cards detail page `QuickSummary` — shows `dueDate`-formatted value

`billingMonth` remains the **closing month** (the month a purchase is counted
in), so the Despesas card counts a fatura under its billing month while the
daily planner and upcoming-items views show it on its real due date. This is
intentional and correct.

Imports may cover past or future periods. Applying an import requires explicit
closing-period review, rejection of closed accounting months and an estimate
warning for future/configuration-derived cycles. A due-only source is converted
using actual closing when present, otherwise a reviewed configuration estimate.
Do not subtract one month from all legacy imports. Purchase date, institution
posted date and installment occurrence date are separate concepts.

**Raw materialized installment `date`**: the `date` column on individual
`scheduled_transaction`-generated rows is still the same-month value (the
closing month). This means the raw Transactions list may show a card installment
a month earlier than its fatura due date. Aligning those dates would require
re-materialization of all existing rows and is a lower-priority item.
