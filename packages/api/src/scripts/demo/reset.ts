/**
 * Deletes ALL data of the demo personas (and ONLY them). Demo personas are
 * identified by the e-mail suffix `@demo.financial-control.test` — both in
 * `user_profiles` (domain) and in the better-auth `user` table.
 *
 * Deletion order respects the FK graph (transactions → scheduled_transactions
 * → accounts → ...): `transactions.source/destination_account_id` and
 * `scheduled_transactions.*_account_id` are ON DELETE RESTRICT, so rows must
 * go before their accounts. Config tables (credit_card_configs,
 * income_source_configs, loan_configs, family_loan_configs, borrowed_cards,
 * credit_card_bills, account_balance_snapshots, account_shares) cascade from
 * `accounts`.
 */
import type { Database } from '@fc/db';
import {
  account,
  accounts,
  auditLog,
  categories,
  materializationStatus,
  monthClosings,
  scheduledTransactions,
  session,
  simulationScenarios,
  transactions,
  user,
  userProfiles,
  verification,
} from '@fc/db';
import { eq, like } from 'drizzle-orm';
import { DEMO_EMAIL_SUFFIX } from './personas.ts';

export type ResetSummary = { profiles: number; authUsers: number };

export async function resetDemoData(db: Database): Promise<ResetSummary> {
  const pattern = `%${DEMO_EMAIL_SUFFIX}`;

  const profiles = await db
    .select({ id: userProfiles.id, email: userProfiles.email })
    .from(userProfiles)
    .where(like(userProfiles.email, pattern));

  for (const profile of profiles) {
    await db.delete(transactions).where(eq(transactions.userId, profile.id));
    await db.delete(scheduledTransactions).where(eq(scheduledTransactions.userId, profile.id));
    // Cascades: credit_card_configs, credit_card_bills, income_source_configs,
    // loan_configs, family_loan_configs, borrowed_cards, snapshots, shares.
    await db.delete(accounts).where(eq(accounts.userId, profile.id));
    await db.delete(categories).where(eq(categories.userId, profile.id));
    await db.delete(materializationStatus).where(eq(materializationStatus.userId, profile.id));
    await db.delete(monthClosings).where(eq(monthClosings.userId, profile.id));
    await db.delete(simulationScenarios).where(eq(simulationScenarios.userId, profile.id));
    await db.delete(auditLog).where(eq(auditLog.userId, profile.id));
    await db.delete(userProfiles).where(eq(userProfiles.id, profile.id));
  }

  const authUsers = await db
    .select({ id: user.id, email: user.email })
    .from(user)
    .where(like(user.email, pattern));

  for (const authUser of authUsers) {
    await db.delete(session).where(eq(session.userId, authUser.id));
    await db.delete(account).where(eq(account.userId, authUser.id));
    await db.delete(user).where(eq(user.id, authUser.id));
  }

  await db.delete(verification).where(like(verification.identifier, pattern));

  return { profiles: profiles.length, authUsers: authUsers.length };
}
