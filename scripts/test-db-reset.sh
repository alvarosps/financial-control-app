#!/usr/bin/env bash
# Reset the test database to a known-clean state matching the Drizzle schema.
#
# Why: the test DB drifts from production schema over time (manual SQL,
# partially-applied migrations, ad-hoc fixes during test development).
# This script gives you one button to restore parity.
#
# Safety:
#   1. Refuses to run unless DATABASE_URL points to a DB whose name ends in `_test`.
#   2. Requires explicit `--confirm` flag.
#   3. Backs up the current test DB before doing anything destructive.
#
# Usage:
#   DATABASE_URL=postgresql://postgres:postgres@localhost:5433/financial_control_v2_test \
#     pnpm test:db:reset --confirm

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO_ROOT"

# ---------- 1. Resolve DATABASE_URL ----------------------------------------
# Allow override via TEST_DATABASE_URL → DATABASE_URL → .env DATABASE_URL.
if [ -z "${DATABASE_URL:-}" ] && [ -n "${TEST_DATABASE_URL:-}" ]; then
  DATABASE_URL="$TEST_DATABASE_URL"
fi

if [ -z "${DATABASE_URL:-}" ] && [ -f .env ]; then
  # Try to read TEST_DATABASE_URL from .env first, then DATABASE_URL.
  TEST_URL_FROM_ENV=$(grep -E '^TEST_DATABASE_URL=' .env | head -n1 | cut -d= -f2- || true)
  if [ -n "$TEST_URL_FROM_ENV" ]; then
    DATABASE_URL="$TEST_URL_FROM_ENV"
  fi
fi

if [ -z "${DATABASE_URL:-}" ]; then
  echo "ERROR: DATABASE_URL (or TEST_DATABASE_URL) is not set."
  echo "Usage: DATABASE_URL=postgresql://.../<dbname>_test pnpm test:db:reset --confirm"
  exit 2
fi

export DATABASE_URL

# ---------- 2. Parse confirm flag ------------------------------------------
CONFIRM=false
for arg in "$@"; do
  case "$arg" in
    --confirm) CONFIRM=true ;;
  esac
done

# ---------- 3. Parse DB name / host / port / user from URL -----------------
# Expected form: postgresql://user:pass@host:port/dbname
DB_URL_NO_PROTO="${DATABASE_URL#postgresql://}"
DB_URL_NO_PROTO="${DB_URL_NO_PROTO#postgres://}"

DB_AUTH="${DB_URL_NO_PROTO%%@*}"
DB_REST="${DB_URL_NO_PROTO#*@}"

DB_USER="${DB_AUTH%%:*}"
DB_PASS="${DB_AUTH#*:}"

DB_HOSTPORT="${DB_REST%%/*}"
DB_NAME_AND_QS="${DB_REST#*/}"
DB_NAME="${DB_NAME_AND_QS%%\?*}"

DB_HOST="${DB_HOSTPORT%%:*}"
DB_PORT="${DB_HOSTPORT#*:}"
if [ "$DB_PORT" = "$DB_HOSTPORT" ]; then
  DB_PORT=5432
fi

echo "=== Test DB Reset ==="
echo "  Host:     $DB_HOST"
echo "  Port:     $DB_PORT"
echo "  User:     $DB_USER"
echo "  Database: $DB_NAME"
echo

# ---------- 4. Safety: db name must end in _test ---------------------------
case "$DB_NAME" in
  *_test)
    ;;
  *)
    echo "REFUSED: database name '$DB_NAME' does NOT end in '_test'."
    echo "This script will only operate on databases whose name ends in '_test'."
    echo "Refusing to drop schema on what looks like a non-test database."
    exit 3
    ;;
esac

# ---------- 5. Safety: --confirm required ----------------------------------
if [ "$CONFIRM" != true ]; then
  echo "REFUSED: --confirm flag is required."
  echo
  echo "This script will:"
  echo "  1. Backup '$DB_NAME' to backups/test-db-reset-<timestamp>.dump"
  echo "  2. DROP SCHEMA public CASCADE / CREATE SCHEMA public"
  echo "  3. Re-apply Drizzle schema via drizzle-kit push --force"
  echo "  4. Apply idempotent post-push SQL (functions, triggers, RLS)"
  echo
  echo "Re-run with --confirm to proceed."
  exit 4
fi

# ---------- 6. Backup -------------------------------------------------------
TIMESTAMP=$(date +%Y%m%d_%H%M%S)
BACKUP_DIR="$REPO_ROOT/backups"
mkdir -p "$BACKUP_DIR"
BACKUP_FILE="$BACKUP_DIR/test-db-reset-${TIMESTAMP}.dump"

echo "=== Step 1/4: Backup ==="
PGPASSWORD="$DB_PASS" pg_dump \
  -h "$DB_HOST" \
  -p "$DB_PORT" \
  -U "$DB_USER" \
  -Fc "$DB_NAME" > "$BACKUP_FILE"
pg_restore --list "$BACKUP_FILE" >/dev/null
echo "Backup saved: $BACKUP_FILE"
echo

# ---------- 7. Drop schema --------------------------------------------------
echo "=== Step 2/4: Drop & recreate public schema ==="
PGPASSWORD="$DB_PASS" psql \
  -h "$DB_HOST" \
  -p "$DB_PORT" \
  -U "$DB_USER" \
  -d "$DB_NAME" \
  -v ON_ERROR_STOP=1 \
  -c "DROP SCHEMA IF EXISTS public CASCADE; CREATE SCHEMA public; GRANT ALL ON SCHEMA public TO $DB_USER; GRANT ALL ON SCHEMA public TO public;"
echo "public schema reset."
echo

# ---------- 8. drizzle-kit push --------------------------------------------
echo "=== Step 3/4: drizzle-kit push --force ==="
(
  cd packages/db
  pnpm drizzle-kit push --force
)
echo

# ---------- 9. Apply canonical triggers/RLS SQL ----------------------------
# `drizzle-kit push --force` recreates all schema-derived objects (tables,
# columns, CHECK constraints, FKs, the domain_type enum, partial unique
# indexes). It does NOT emit:
#   - plpgsql functions (recalculate_account_balance, trigger_set_updated_at, ...)
#   - the triggers that call them
#   - RLS ENABLE / policies
# packages/db/src/sql/triggers-and-rls.sql is the SINGLE SOURCE OF TRUTH for
# those objects (idempotent form). Historical migrations under
# packages/db/drizzle/ are frozen; future changes update the canonical file.
echo "=== Step 4/4: Apply canonical triggers/RLS SQL ==="
PGPASSWORD="$DB_PASS" psql \
  -h "$DB_HOST" \
  -p "$DB_PORT" \
  -U "$DB_USER" \
  -d "$DB_NAME" \
  -v ON_ERROR_STOP=1 \
  -f "packages/db/src/sql/triggers-and-rls.sql"
echo

echo "=== Test DB reset complete ==="
echo "Backup: $BACKUP_FILE"
echo "Run: pnpm --filter @fc/api test"
