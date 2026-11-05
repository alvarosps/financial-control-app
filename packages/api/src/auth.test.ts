import { account, session, user, userProfiles } from '@fc/db';
import { eq } from 'drizzle-orm';
import { afterEach, describe, expect, it } from 'vitest';
import { createAuth } from './auth.ts';
import { resolveUserProfileByAuthUserId } from './lib/user-profile.ts';
import { getTestDb } from './test/pool.ts';

/**
 * Regression test for finding #19: sign-up (better-auth) must provision a
 * matching `user_profiles` row via the `databaseHooks.user.create.after`
 * hook, otherwise every new user sees "Not authenticated" everywhere.
 *
 * better-auth commits its own writes outside of our request transactions,
 * so this test cannot use `withRollback` and instead cleans up explicitly.
 */
describe('createAuth databaseHooks.user.create.after', () => {
  const testEmails: string[] = [];

  afterEach(async () => {
    const db = getTestDb();
    for (const email of testEmails.splice(0)) {
      const [authUser] = await db.select().from(user).where(eq(user.email, email)).limit(1);
      if (authUser) {
        await db.delete(session).where(eq(session.userId, authUser.id));
        await db.delete(account).where(eq(account.userId, authUser.id));
        await db.delete(user).where(eq(user.id, authUser.id));
      }
      await db.delete(userProfiles).where(eq(userProfiles.email, email));
    }
  });

  it('provisions exactly one user_profiles row on sign-up', async () => {
    const db = getTestDb();
    const auth = createAuth(db);
    const email = `signup-test-${Date.now()}-${Math.random().toString(36).slice(2)}@test.com`;
    testEmails.push(email);

    const result = await auth.api.signUpEmail({
      body: { email, password: 'super-secret-password-123', name: 'Signup Test' },
    });

    const profiles = await db
      .select()
      .from(userProfiles)
      .where(eq(userProfiles.authUserId, result.user.id));
    expect(profiles).toHaveLength(1);
    expect(profiles[0]?.email).toBe(email);
    expect(profiles[0]?.name).toBe('Signup Test');

    const resolved = await resolveUserProfileByAuthUserId(db, result.user.id);
    expect(resolved).toEqual({ id: profiles[0]?.id });
  });
});
