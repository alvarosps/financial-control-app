-- Manual migration (psql, pattern 0009/0011/0012 -- NOT journaled).
-- Applied: 2026-07-09
--
-- Better-auth tables used timestamp WITHOUT time zone while the rest of the
-- schema uses timestamptz. Converts with AT TIME ZONE 'UTC', matching
-- postgres-js Date serialization as an instant. Investigation on 2026-07-09:
-- the dev session table was empty, and no historical session rows contradicted
-- the UTC assumption.

ALTER TABLE "user"
  ALTER COLUMN created_at TYPE timestamptz USING created_at AT TIME ZONE 'UTC',
  ALTER COLUMN updated_at TYPE timestamptz USING updated_at AT TIME ZONE 'UTC';

ALTER TABLE session
  ALTER COLUMN expires_at TYPE timestamptz USING expires_at AT TIME ZONE 'UTC',
  ALTER COLUMN created_at TYPE timestamptz USING created_at AT TIME ZONE 'UTC',
  ALTER COLUMN updated_at TYPE timestamptz USING updated_at AT TIME ZONE 'UTC';

ALTER TABLE account
  ALTER COLUMN access_token_expires_at TYPE timestamptz USING access_token_expires_at AT TIME ZONE 'UTC',
  ALTER COLUMN refresh_token_expires_at TYPE timestamptz USING refresh_token_expires_at AT TIME ZONE 'UTC',
  ALTER COLUMN created_at TYPE timestamptz USING created_at AT TIME ZONE 'UTC',
  ALTER COLUMN updated_at TYPE timestamptz USING updated_at AT TIME ZONE 'UTC';

ALTER TABLE verification
  ALTER COLUMN expires_at TYPE timestamptz USING expires_at AT TIME ZONE 'UTC',
  ALTER COLUMN created_at TYPE timestamptz USING created_at AT TIME ZONE 'UTC',
  ALTER COLUMN updated_at TYPE timestamptz USING updated_at AT TIME ZONE 'UTC';
