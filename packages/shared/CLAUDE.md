# @fc/shared

Cross-cutting constants and types shared across packages. No dependency on `db`, `api`, or `web`.

## What lives here

- `enums.ts` — shared enums.
- `system-accounts.ts` — well-known system account ids/definitions.
- `global-error-copy.ts` — shared error message copy.
- `types.ts` — cross-cutting TypeScript types.

## Rules

- Keep it dependency-light and side-effect-free — this package is imported widely; anything heavy here leaks everywhere.
- Export public API from `src/index.ts`.
- If a type is purely domain logic, prefer `@fc/domain`; `@fc/shared` is for things both server and web need (enums, system-account ids, copy).
- Biome owns formatting/imports. No `any`.
