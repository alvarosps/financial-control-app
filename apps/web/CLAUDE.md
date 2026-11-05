# web (Next.js App Router)

The financial-control-v2 frontend. Next.js App Router + TanStack Query + tRPC client + shadcn/ui.

## Layout

- `src/app/(auth)`, `src/app/(dashboard)` — route groups (pages).
- `src/app/api/trpc/[trpc]` — the tRPC route handler that serves `@fc/api` (this is "the backend").
- `src/lib/trpc/` — tRPC client + React Query integration. `src/lib/providers/` — app providers.
- `src/lib/auth-client.ts` — better-auth client.
- `src/components/`, `src/hooks/` — UI building blocks.
- `src/i18n/messages/{en,pt-BR}.json` — translations.

## Hard rules

- **NEVER import `@fc/db` here.** Reach the database only through `@fc/api` (tRPC). Biome enforces this with `noRestrictedImports` — a direct `@fc/db` import is a lint error.
- **i18n parity**: every user-facing string is a translation key present in BOTH `en.json` AND `pt-BR.json`. Never hardcode display text. `pnpm i18n:check` (and the `/i18n-parity` skill) verifies parity.
- Data fetching/mutations go through the tRPC client (TanStack Query hooks). Invalidate the relevant queries on mutation success.
- Auth via the better-auth client — don't reimplement session/token handling.

## Conventions

- Biome owns formatting/imports (single quotes, trailing commas, 2-space, width 100). No `any`.
- Display values: feature screens show positive amounts; only transaction lists show signed values (direction). Keep this consistent with existing pages.

## Typography

Three families, loaded in `src/app/layout.tsx` via `next/font` and mapped in `globals.css` `@theme inline`:

- `font-sans` — Geist: body copy, forms, labels.
- `font-heading` — Space Grotesk: page/card/dialog/sheet titles, section headers.
- `font-numeric` — Geist Mono: every monetary or tabular figure. Always pair with `tabular-nums`.

Type scale (use these exact combos, don't invent new ones):

| Role | Classes |
|---|---|
| Display / page title | `font-heading text-2xl font-bold tracking-tight` |
| Card/section/dialog title | `font-heading text-base font-medium leading-snug` |
| Body | `font-sans text-sm` |
| Caption / KPI label | `text-xs font-medium uppercase tracking-wider text-muted-foreground` |
| KPI value | `font-numeric text-2xl font-bold tabular-nums` |
| Table/list amount | `font-numeric tabular-nums` (+ contextual `text-sm`) |

```bash
pnpm --filter @fc/web dev
pnpm --filter @fc/web test
```

## Surfaces & motion

- **Surface rule:** `glass` = KPI/summary layer (StatCards, hero, insight banners); `solid` = data layer (lists, item cards, tables, charts). `Card`/`StatCard` take `surface="glass" | "solid"` — pick by layer, never by taste.
- **Motion rule:** ONE orchestrated moment per page — the entrance cascade (`stagger-item` + `--stagger-index`). Count-up (`CountUpAmount`/`useCountUp`) only on mount-stable values (dashboard hero/summary); never on frequently-updating figures (e.g. simulator KPIs). Everything motion-related sits behind `motion-safe`/`usePrefersReducedMotion`, and recharts series use `animationDuration={220}` (= `--dur-base`) with `isAnimationActive={!prefersReducedMotion}` (see `lib/chart-conventions.ts`).
