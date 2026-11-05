import { createEnv } from '@t3-oss/env-nextjs';
import { z } from 'zod';

const PLACEHOLDER_SECRETS = new Set([
  'your-secret-here',
  'change-me',
  'changeme',
  'change_me',
  'replace-me',
  'development',
  'dev',
  'secret',
  'password',
  'test',
  'example',
  'placeholder',
]);

/**
 * BETTER_AUTH_SECRET validator — enforced at app startup via @t3-oss/env-nextjs.
 * Runtime placement matters: a weak/placeholder secret must never be accepted,
 * because Better Auth uses it to sign every session token. Rejecting here
 * prevents silent auth compromise in accidentally-shipped builds.
 */
export const strongSecret = z
  .string()
  .transform((v) => v.trim())
  .refine((v) => v.length >= 32, {
    message: 'BETTER_AUTH_SECRET must be at least 32 characters',
  })
  .refine((v) => !PLACEHOLDER_SECRETS.has(v.toLowerCase()), {
    message:
      'BETTER_AUTH_SECRET is a known placeholder — generate a real one (openssl rand -hex 32)',
  })
  .refine((v) => new Set(v).size >= 8, {
    message: 'BETTER_AUTH_SECRET has too little entropy (fewer than 8 distinct characters)',
  });

export const env = createEnv({
  server: {
    DATABASE_URL: z.string().url(),
    APP_DATABASE_URL: z.string().url(),
    BETTER_AUTH_SECRET: strongSecret,
    TRUSTED_ORIGINS: z.string().optional(),
  },
  client: {
    NEXT_PUBLIC_APP_URL: z.string().url().optional(),
  },
  runtimeEnv: {
    DATABASE_URL: process.env.DATABASE_URL,
    APP_DATABASE_URL: process.env.APP_DATABASE_URL,
    BETTER_AUTH_SECRET: process.env.BETTER_AUTH_SECRET,
    TRUSTED_ORIGINS: process.env.TRUSTED_ORIGINS,
    NEXT_PUBLIC_APP_URL: process.env.NEXT_PUBLIC_APP_URL,
  },
  skipValidation: process.env.SKIP_ENV_VALIDATION === '1',
});
