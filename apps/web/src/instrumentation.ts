/**
 * Runs once at server startup. We import `env` for its validation side
 * effect — `@t3-oss/env-nextjs` throws on invalid/missing/placeholder env
 * vars. Importing here guarantees the server crashes loud on boot rather
 * than on the first request that happens to need `BETTER_AUTH_SECRET`.
 *
 * Next.js docs: https://nextjs.org/docs/app/building-your-application/optimizing/instrumentation
 */
export async function register() {
  if (process.env.NEXT_RUNTIME === 'nodejs') {
    await import('./lib/env');
  }
}
