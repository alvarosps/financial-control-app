/**
 * Prints the per-persona entity inventory at the end of the demo seed, so a
 * human can eyeball that every mapping produced data (and that the empty
 * persona stayed empty).
 */
import type { Database } from '@fc/db';
import { accounts, categories, creditCardBills, scheduledTransactions, transactions } from '@fc/db';
import { asc, count, eq, sql } from 'drizzle-orm';

export type PersonaRef = { key: string; email: string; userId: string };

export async function printInventory(db: Database, refs: PersonaRef[]): Promise<void> {
  console.log('\n================ INVENTÁRIO ================');
  for (const ref of refs) {
    console.log(`\n--- ${ref.key} <${ref.email}> (user ${ref.userId.slice(0, 8)}) ---`);

    const [categoryRow] = await db
      .select({ n: count() })
      .from(categories)
      .where(eq(categories.userId, ref.userId));
    console.log(`categorias: ${categoryRow?.n ?? 0}`);

    const accountRows = await db
      .select({ type: accounts.type, n: count() })
      .from(accounts)
      .where(eq(accounts.userId, ref.userId))
      .groupBy(accounts.type)
      .orderBy(asc(accounts.type));
    console.log(`contas: ${accountRows.length === 0 ? '0' : ''}`);
    for (const row of accountRows) {
      console.log(`  ${row.type}: ${row.n}`);
    }

    const scheduleRows = await db
      .select({ domainType: scheduledTransactions.domainType, n: count() })
      .from(scheduledTransactions)
      .where(eq(scheduledTransactions.userId, ref.userId))
      .groupBy(scheduledTransactions.domainType)
      .orderBy(asc(scheduledTransactions.domainType));
    const scheduleTotal = scheduleRows.reduce((acc, r) => acc + Number(r.n), 0);
    console.log(`schedules: ${scheduleTotal}`);
    for (const row of scheduleRows) {
      console.log(`  ${row.domainType ?? '(sem domain_type)'}: ${row.n}`);
    }

    const txRows = await db
      .select({
        domainType: transactions.domainType,
        n: count(),
        paid: sql<string>`count(*) filter (where ${transactions.isPaid})`,
      })
      .from(transactions)
      .where(eq(transactions.userId, ref.userId))
      .groupBy(transactions.domainType)
      .orderBy(asc(transactions.domainType));
    const txTotal = txRows.reduce((acc, r) => acc + Number(r.n), 0);
    console.log(`transações: ${txTotal}`);
    for (const row of txRows) {
      console.log(`  ${row.domainType ?? '(sem domain_type)'}: ${row.n} (${row.paid} paga(s))`);
    }

    const [billRow] = await db
      .select({ n: count() })
      .from(creditCardBills)
      .innerJoin(accounts, eq(accounts.id, creditCardBills.creditCardAccountId))
      .where(eq(accounts.userId, ref.userId));
    console.log(`faturas registradas (credit_card_bills): ${billRow?.n ?? 0}`);
  }
  console.log('\n============================================');
}
