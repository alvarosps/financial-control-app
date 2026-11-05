#!/usr/bin/env bash
# Compare the schema produced by the full migration history with the schema
# produced by Drizzle push plus the canonical triggers/RLS SQL.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO_ROOT"

SOURCE_DATABASE_URL="${TEST_DATABASE_URL:-${DATABASE_URL:-}}"
if [ -z "$SOURCE_DATABASE_URL" ]; then
  echo 'ERROR: TEST_DATABASE_URL or DATABASE_URL is required.'
  exit 2
fi

export SOURCE_DATABASE_URL
export PGOPTIONS="${PGOPTIONS:+$PGOPTIONS }-c client_min_messages=warning"

database_url() {
  node -e '
    const url = new URL(process.env.SOURCE_DATABASE_URL);
    url.pathname = `/${process.argv[1]}`;
    console.log(url.toString());
  ' "$1"
}

SOURCE_DATABASE_NAME="$(node -e 'console.log(decodeURIComponent(new URL(process.env.SOURCE_DATABASE_URL).pathname.slice(1)))')"
case "$SOURCE_DATABASE_NAME" in
  *_test) ;;
  *)
    echo "REFUSED: source database '$SOURCE_DATABASE_NAME' does not end in _test."
    exit 3
    ;;
esac

SUFFIX="${GITHUB_RUN_ID:-${RANDOM}${RANDOM}}"
SUFFIX="$(printf '%s' "$SUFFIX" | tr -cd '[:alnum:]' | tr '[:upper:]' '[:lower:]' | cut -c1-20)"
REPLAY_DATABASE="fc_replay_${SUFFIX}_test"
CANONICAL_DATABASE="fc_canonical_${SUFFIX}_test"
ADMIN_DATABASE_URL="$(database_url postgres)"
REPLAY_DATABASE_URL="$(database_url "$REPLAY_DATABASE")"
CANONICAL_DATABASE_URL="$(database_url "$CANONICAL_DATABASE")"
WORKDIR="$(mktemp -d "${TMPDIR:-/tmp}/fc-canonical-sql.XXXXXX")"

database_exists() {
  psql "$ADMIN_DATABASE_URL" -Atq -c "SELECT 1 FROM pg_database WHERE datname = '$1'" | grep -qx '1'
}

backup_and_drop_database() {
  local database_name="$1"
  local database_connection="$2"

  if ! database_exists "$database_name"; then
    return
  fi

  pg_dump "$database_connection" -Fc > "$WORKDIR/${database_name}-before-drop.dump"
  pg_restore --list "$WORKDIR/${database_name}-before-drop.dump" >/dev/null
  psql "$ADMIN_DATABASE_URL" -v ON_ERROR_STOP=1 -c \
    "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = '$database_name' AND pid <> pg_backend_pid();" \
    >/dev/null
  psql "$ADMIN_DATABASE_URL" -v ON_ERROR_STOP=1 -c "DROP DATABASE \"$database_name\"" >/dev/null
}

cleanup() {
  backup_and_drop_database "$CANONICAL_DATABASE" "$CANONICAL_DATABASE_URL"
  backup_and_drop_database "$REPLAY_DATABASE" "$REPLAY_DATABASE_URL"
}
trap cleanup EXIT

for database_name in "$REPLAY_DATABASE" "$CANONICAL_DATABASE"; do
  if database_exists "$database_name"; then
    backup_and_drop_database "$database_name" "$(database_url "$database_name")"
  fi
  psql "$ADMIN_DATABASE_URL" -v ON_ERROR_STOP=1 -c "CREATE DATABASE \"$database_name\" TEMPLATE template0" >/dev/null
  pg_dump "$(database_url "$database_name")" -Fc > "$WORKDIR/${database_name}-before-schema.dump"
  pg_restore --list "$WORKDIR/${database_name}-before-schema.dump" >/dev/null
done

echo '=== Replay migration history ==='
journal_migrations_output="$(
  node -e "for (const entry of require('./packages/db/drizzle/meta/_journal.json').entries) console.log(entry.tag + '.sql')"
)"
mapfile -t journal_migrations <<< "$journal_migrations_output"

expected_journal_migrations=(
  0000_chief_zemo.sql
  0001_spicy_purifiers.sql
  0002_silent_puff_adder.sql
  0003_slippery_gorgon.sql
  0004_bright_doctor_octopus.sql
  0005_noisy_ben_parker.sql
  0006_marvelous_invisible_woman.sql
  0007_supreme_xavin.sql
  0008_nebulous_echo.sql
  0009_supreme_shard.sql
  0010_exotic_bucky.sql
  0011_payroll_guards.sql
  0012_wallet_cash_selection.sql
  0013_preserve_ledger_balance.sql
  0014_cynical_clea.sql
  0015_purchase_link_revocation.sql
  0016_purchase_refund_schedule.sql
  0017_legal_joseph.sql
  0018_blue_dark_phoenix.sql
  0019_parched_stone_men.sql
  0020_fantastic_blur.sql
  0021_tearful_vision.sql
  0022_calm_micromax.sql
  0023_eminent_wendell_vaughn.sql
  0024_thankful_the_santerians.sql
  0025_previous_mandarin.sql
  0026_sudden_screwball.sql
  0027_closing_period_refinements.sql
)

if [[ "${journal_migrations[*]}" != "${expected_journal_migrations[*]}" ]]; then
  echo 'The Drizzle journal changed. Update the historical replay sequence before running this check.' >&2
  exit 4
fi

replay_journal_migrations() {
  local migration
  for migration in "$@"; do
    echo "  $migration"
    sed 's/--> statement-breakpoint//g' "packages/db/drizzle/$migration" \
      | psql -q "$REPLAY_DATABASE_URL" -v ON_ERROR_STOP=1
  done
}

replay_manual_migrations() {
  local migration
  for migration in "$@"; do
    echo "  $migration"
    psql -q "$REPLAY_DATABASE_URL" -v ON_ERROR_STOP=1 -f "packages/db/drizzle/$migration"
  done
}

mapfile -t early_manual_migrations < <(node -e "console.log(require('./scripts/lib/manual-migration-order.json').early.join('\n'))")
mapfile -t late_manual_migrations < <(node -e "console.log(require('./scripts/lib/manual-migration-order.json').late.join('\n'))")

replay_journal_migrations "${journal_migrations[@]:0:4}"
replay_manual_migrations "${early_manual_migrations[@]}"
replay_journal_migrations "${journal_migrations[@]:4:5}"
replay_manual_migrations "${late_manual_migrations[@]}"
replay_journal_migrations "${journal_migrations[@]:9}"

psql -q "$REPLAY_DATABASE_URL" -v ON_ERROR_STOP=1 <<'SQL'
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_roles WHERE rolname = 'app_user' AND NOT rolsuper AND NOT rolbypassrls
  ) THEN
    RAISE EXCEPTION 'migration replay did not create the constrained app_user role';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public'
      AND c.relname IN ('user', 'account', 'session', 'verification')
      AND (c.relrowsecurity OR c.relforcerowsecurity)
  ) THEN
    RAISE EXCEPTION 'Better Auth tables must not have RLS enabled or forced';
  END IF;
END $$;
SQL

echo '=== Rebuild canonical test schema ==='
drizzle_push_log="$WORKDIR/drizzle-push.log"
if ! (
  cd packages/db
  DATABASE_URL="$CANONICAL_DATABASE_URL" pnpm drizzle-kit push --force
) >"$drizzle_push_log" 2>&1; then
  cat "$drizzle_push_log" >&2
  exit 1
fi
psql -q "$CANONICAL_DATABASE_URL" -v ON_ERROR_STOP=1 -f packages/db/src/sql/triggers-and-rls.sql

dump_schema() {
  pg_dump "$1" --schema-only --schema=public --no-owner \
    | sed -E \
      -e '/^--/d' \
      -e '/^[[:space:]]*--/d' \
      -e '/^SET /d' \
      -e '/^SELECT pg_catalog.set_config/d' \
      -e '/^\\(un)?restrict/d' \
      -e '/^$/d'
}

REPLAY_SCHEMA="$WORKDIR/replay-schema.sql"
CANONICAL_SCHEMA="$WORKDIR/canonical-schema.sql"
dump_schema "$REPLAY_DATABASE_URL" > "$REPLAY_SCHEMA"
dump_schema "$CANONICAL_DATABASE_URL" > "$CANONICAL_SCHEMA"

if ! diff -u "$REPLAY_SCHEMA" "$CANONICAL_SCHEMA"; then
  echo "Schema drift detected. Temporary backups and dumps: $WORKDIR" >&2
  exit 1
fi

echo 'Canonical SQL matches the replayed migration schema.'
