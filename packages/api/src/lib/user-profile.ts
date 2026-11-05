import { type DbExecutor, userProfiles } from '@fc/db';
import { eq, sql } from 'drizzle-orm';

export async function resolveUserProfileByAuthUserId(
  db: DbExecutor,
  authUserId: string,
): Promise<{ id: string } | null> {
  return await db.transaction(async (tx) => {
    await tx.execute(sql`SELECT set_config('app.current_auth_user_id', ${authUserId}, true)`);
    const [row] = await tx
      .select({ id: userProfiles.id })
      .from(userProfiles)
      .where(eq(userProfiles.authUserId, authUserId))
      .limit(1);
    return row ?? null;
  });
}

/**
 * Provisions the `user_profiles` row for a freshly created better-auth user.
 * Called from the `databaseHooks.user.create.after` hook so every new
 * sign-up immediately has a matching application profile.
 *
 * Idempotent: concurrent/duplicate calls for the same `authUserId` resolve
 * to the same row via `onConflictDoNothing` + a post-insert lookup.
 */
export async function provisionUserProfile(
  db: DbExecutor,
  params: { authUserId: string; email: string; name: string },
): Promise<{ id: string }> {
  const { authUserId, email, name } = params;
  return await db.transaction(async (tx) => {
    const id = crypto.randomUUID();
    // Satisfies the RLS WITH CHECK on user_profiles_isolation when the
    // runtime connection is the non-superuser app_user role.
    await tx.execute(sql`SELECT set_config('app.current_user_id', ${id}, true)`);
    await tx.execute(sql`SELECT set_config('app.current_auth_user_id', ${authUserId}, true)`);

    await tx
      .insert(userProfiles)
      .values({ id, email, name, authUserId })
      .onConflictDoNothing({ target: userProfiles.authUserId });

    // Re-resolve by authUserId to cover the race where a concurrent call
    // already inserted the row (onConflictDoNothing is a no-op then).
    const [row] = await tx
      .select({ id: userProfiles.id })
      .from(userProfiles)
      .where(eq(userProfiles.authUserId, authUserId))
      .limit(1);
    if (!row) {
      throw new Error(
        `provisionUserProfile: failed to resolve profile for authUserId=${authUserId}`,
      );
    }
    return row;
  });
}
