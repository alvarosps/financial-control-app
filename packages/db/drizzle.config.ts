import { config } from 'dotenv';
import { defineConfig } from 'drizzle-kit';
import { resolveDatabaseTarget } from '../../scripts/lib/database-target.ts';

config({ path: '../../.env', quiet: true });

const target = resolveDatabaseTarget(process.env);

export default defineConfig({
  schema: './src/schema/index.ts',
  out: './drizzle',
  dialect: 'postgresql',
  dbCredentials: {
    url: target.migration.url,
  },
});
