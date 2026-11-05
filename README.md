# Financial Control

Personal finance application for accounts, credit-card bills, installment purchases, recurring income, loans and cash-flow projections. Available in English and Brazilian Portuguese.

![Dashboard with entirely fictional local demo data](docs/images/dashboard-desktop.png)

[Mobile dashboard with the same fictional dataset](docs/images/dashboard-mobile.png).

## Architecture

```mermaid
flowchart LR
  Web[Next.js web application] --> API[tRPC API and better-auth]
  API --> Domain[Money and scheduling rules]
  API --> DB[Drizzle and PostgreSQL]
  DB --> RLS[User isolation with row-level security]
```

The pnpm/Turborepo workspace separates pure business rules (`packages/domain`), shared contracts (`packages/shared`), schema and migrations (`packages/db`), services and routers (`packages/api`), and the application (`apps/web`). The API runs inside Next.js. Money calculations use decimal value objects. Scheduled transactions materialize into calendar entries and projections.

Integration tests use PostgreSQL with real services and rollback transactions. Dedicated isolation tests execute queries as the restricted runtime role. The optional Kotlin notification collector lives in `apps/android-capture` with its own build instructions.

## Data and privacy

Each clone starts with its own local PostgreSQL database. All screenshots and optional demo personas use fictional data. The repository contains an environment template, and the person running the installation supplies their own configuration. In a shared instance, the application authenticates each user and restricts access to that user's financial records. Anyone administering the database can access the records in that installation. Use fictional data for portfolio demonstrations.

## Run locally

Requires Node 24.14.1, pnpm 10.33.0 and PostgreSQL client tools (`psql`, `pg_dump`, `pg_restore`) on PATH. Bash scripts require Bash, for example Git Bash on Windows. Run these PowerShell commands from the repository root.

```powershell
fnm install 24.14.1
fnm use
corepack enable pnpm
pnpm install --frozen-lockfile
docker compose up -d --wait
Copy-Item .env.example .env
```

The included PostgreSQL container uses localhost port 5548 and its own volume. Change the Compose port and connection strings together if that port is occupied. Generate a local authentication secret and write it into `.env` without printing it.

```powershell
$secret = node -e "process.stdout.write(require('crypto').randomBytes(32).toString('hex'))"
(Get-Content .env -Raw).Replace('BETTER_AUTH_SECRET=replace-me', "BETTER_AUTH_SECRET=$secret") | Set-Content -Encoding utf8 .env
Remove-Variable secret
```

Initialize the empty local development database. These variables select the local container explicitly. The command verifies a backup, replays the historical migration order and enables the restricted runtime login. It refuses remote and nonempty databases and preserves credentials of an existing safe runtime role. Use the same runtime password for databases sharing that role in one cluster. Set `PG_BIN_DIR` if your PostgreSQL client programs are outside PATH.

```powershell
$env:DATABASE_URL = 'postgresql://postgres:postgres@localhost:5548/financial_control_v2'
$env:APP_DATABASE_URL = 'postgresql://app_user:app_user@localhost:5548/financial_control_v2'
pnpm db:setup:local --confirm
pnpm dev
```

The root `dev` and `build` commands load `.env` before starting Turborepo. Explicit process environment variables take precedence. If bootstrap fails partway, stop and inspect the named migration and the backup/progress receipt in `scratch/local-setup/`. Preserve that directory. Resolve the migration issue and retry on a new empty isolated database after reviewing the failure. Existing partially initialized databases require a separately reviewed recovery using the verified backup and PostgreSQL tools. The setup command refuses to overwrite them.

Open [localhost:3001](http://localhost:3001), register a local user, create an account and add an income or an installment purchase. The local passwords in these examples are for the loopback-only development container. Use independently generated credentials and a private database for any hosted deployment. Keep application runtime on `app_user` through `APP_DATABASE_URL` and administrative tooling on a separate connection.

## Optional fictional data

The local demo script creates fictional personas and transactions through the application services. Stop the web server and back up the selected local database before running it because it resets the demo personas. Review the script and use it only in a dedicated local environment.

```powershell
pnpm db:backup
pnpm demo:seed --confirm
```

Local persona sign-in details are defined in `packages/api/src/scripts/demo/personas.ts`. These accounts belong exclusively to your local installation. Financial data, statements and credentials from a personal installation must stay outside this repository.

## Checks

Initialize the separate empty test database once, then run the checks. Test fixtures create synthetic data. The setup command automatically backs up before modifying a schema. The reset script also backs up before its destructive reset and requires a database name ending in `_test`.

```powershell
$env:DATABASE_URL = 'postgresql://postgres:postgres@localhost:5548/financial_control_v2_test'
$env:APP_DATABASE_URL = 'postgresql://app_user:app_user@localhost:5548/financial_control_v2_test'
$env:TEST_DATABASE_URL = $env:DATABASE_URL
pnpm db:setup:local --confirm
pnpm lint
pnpm type-check
pnpm test
pnpm build
```

For future schema changes, generate migration SQL, review it and follow the backup/baseline checks in `scripts/db-maintenance.ts` before applying it. Preserve the historical manual migration order in `scripts/lib/manual-migration-order.json`. `pnpm check:db:canonical` compares migration replay with the canonical SQL using disposable test databases and PostgreSQL tooling under Bash.

## Optional integrations

Android capture and Open Finance are disabled in the environment example. They require their own provider credentials, consent, HTTPS and deployment configuration. The Android collector stages observations for review before a ledger entry is created. See its README for device permissions and local verification. Never share pairing tokens or provider credentials in issues.

## Contributing and security

See [CONTRIBUTING.md](CONTRIBUTING.md) for development guidance and [SECURITY.md](SECURITY.md) for private vulnerability reporting. Created by Alvaro Souza. The proposed license for this edition is MIT, included in [LICENSE](LICENSE).
