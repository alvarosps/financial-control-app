-- Trimmed to the real delta: drizzle-kit generate emitted ~30 drift statements already
-- hand-applied to dev/prod (see MIGRATION-ORDER.md); only this change is new.
-- password_hash is a legacy V1 column — better-auth owns credentials now. New signups
-- provision user_profiles without it (auth.ts databaseHooks), so it must be nullable.
ALTER TABLE "user_profiles" ALTER COLUMN "password_hash" DROP NOT NULL;
