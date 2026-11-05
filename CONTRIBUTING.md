# Contributing

Use the toolchain and local setup documented in the README. Work in a branch and open a pull request describing the behavior changed and the checks performed.

Follow the existing package boundaries. The web app calls tRPC and never imports the database package directly. Domain code stays independent of frameworks. Use the Money/Currency objects for amounts and preserve explicit ownership checks alongside RLS. Every user-data endpoint must authenticate the caller and scope access to that user's records.

Use Biome for formatting and import ordering. Keep English and Brazilian Portuguese message keys in parity. Run `pnpm lint`, `pnpm type-check`, relevant tests and `pnpm build` before submitting significant changes. Integration tests use PostgreSQL and real collaborators with rollback transactions. Mock only external boundaries.

Before any schema change or destructive database operation, create and verify a backup. Use a dedicated local or test database. Schema changes include reviewed migrations and the canonical triggers/RLS SQL when applicable.

Use entirely synthetic fixtures and screenshots. Check your staged files and commit history for secrets and personal records before pushing. Keep environment files, dumps, financial statements and local operational reports out of commits. Follow SECURITY.md for private vulnerability reporting.
