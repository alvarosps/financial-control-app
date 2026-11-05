import 'server-only';

import { createDb as createDbInner, type Database } from '@fc/db';

/**
 * Server-only DB bootstrap exposed to the Next.js app so that web code
 * never needs to import from @fc/db directly. This module MUST remain the
 * single entry point through which apps/web reaches the database —
 * enforced by the noRestrictedImports rule in biome.json.
 */

declare global {
  // Process-wide DB singleton handle (see createServerDb). `var` is required to
  // augment globalThis — let/const cannot declare a global.
  var __fc_db: Database | undefined;
}

export function createServerDb(url: string): Database {
  // Process-wide singleton shared across all requests/users. Never set RLS GUCs
  // on this pooled connection at session scope. protectedProcedure sets
  // app.current_user_id inside each request transaction with set_config(..., true)
  // so the value is transaction-local and cannot bleed across concurrent users.
  // Lazily initialise the typed globalThis singleton (see `declare global` above).
  const existing = globalThis.__fc_db ?? createDbInner(url);
  globalThis.__fc_db = existing;
  return existing;
}

export type { Database } from '@fc/db';
// Re-exported for backward compatibility: these are plain server-side
// helpers (no Next.js "server-only" boundary needed) and live in
// ./lib/user-profile.ts so auth.ts (which the Vitest suite exercises
// directly) doesn't transitively pull in the `server-only` guard.
export { provisionUserProfile, resolveUserProfileByAuthUserId } from './lib/user-profile.ts';
