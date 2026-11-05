# @fc/domain

Pure domain logic for financial-control-v2. **No framework or `db`/`api`/`web` imports** — no Drizzle, no tRPC, no React. Runtime deps are limited to `@fc/shared` and `decimal.js` (used by the `Money` value object).

## What lives here

- **Value objects**: `money.ts`, `currency.ts` — amounts always flow through these, never raw numbers.
- **Pure functions / domain math**: `materializer.ts`, `payoff.ts`, `billing-period.ts`, `date-utils.ts`, occurrence generation (`occurrences.*`), `transaction-rules.ts`, `installments/`.
- **Type/enum domain models**: `account-types.ts`, `domain-types.ts`.
- **Errors**: `errors/` — typed domain errors (e.g. empty/too-long value, validation).

## Rules

- Keep everything **pure and deterministic** (no I/O, no clock reads except via injected params, no DB). This is what makes it unit-testable without a database.
- Tests are co-located (`X.ts` → `X.test.ts`) and run fast with no DB. Cover constructor validation, calculated properties, and edge cases (leap year, month rollover, starting occurrence, installment boundaries — see existing `occurrences.*.test.ts`).
- Export public API from `src/index.ts`.
- Biome owns formatting/imports. No `any`.

```bash
pnpm --filter @fc/domain test
```
