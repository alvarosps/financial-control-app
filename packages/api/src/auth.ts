import type { DbExecutor } from '@fc/db';
import { betterAuth } from 'better-auth';
import { drizzleAdapter } from 'better-auth/adapters/drizzle';
import { provisionUserProfile } from './lib/user-profile.ts';

export function createAuth(db: DbExecutor, baseURL?: string) {
  const trustedOrigins = process.env.TRUSTED_ORIGINS
    ? process.env.TRUSTED_ORIGINS.split(',').map((o) => o.trim())
    : ['http://localhost:3001'];

  return betterAuth({
    ...(baseURL ? { baseURL } : {}),
    database: drizzleAdapter(db, { provider: 'pg' }),
    trustedOrigins,
    emailAndPassword: {
      enabled: true,
      minPasswordLength: 12,
      maxPasswordLength: 128,
      disableSignUp: process.env.AUTH_DISABLE_SIGNUP === 'true',
    },
    rateLimit: {
      window: 60,
      max: 10,
    },
    session: {
      expiresIn: 60 * 60 * 24 * 7, // 7 days
      updateAge: 60 * 60 * 24, // daily refresh
    },
    databaseHooks: {
      user: {
        create: {
          after: async (user) => {
            await provisionUserProfile(db, {
              authUserId: user.id,
              email: user.email,
              name: user.name,
            });
          },
        },
      },
    },
  });
}
