import type { DbExecutor } from '@fc/db';
import { userProfiles } from '@fc/db';

let sequence = 0;

export async function createTestUser(db: DbExecutor) {
  sequence += 1;
  const [user] = await db
    .insert(userProfiles)
    .values({
      email: `fatura-${sequence}-${Math.random().toString(36).slice(2)}@example.com`,
      name: 'Fatura Test User',
      passwordHash: 'hashed',
    })
    .returning();
  if (user === undefined) throw new Error('createTestUser returned no row');
  return user;
}
