import { config } from 'dotenv';
import { configureTestDatabaseEnvironment } from '../../../scripts/lib/database-target.ts';

config({ path: '../../.env', quiet: true });
configureTestDatabaseEnvironment(process.env);
