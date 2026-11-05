/**
 * Billing utilities for UI components.
 * Keeps date arithmetic out of @fc/domain imports in client components.
 */

/**
 * Calculate the start_date for a scheduled transaction based on the card's
 * closing day, due day, and the current installment number.
 *
 * Formula: if the installment is X/N in the current billing month (today),
 * then start_date = first day of (currentMonth - X + 1).
 *
 * For recurring expenses (no installment), currentInstallment defaults to 1.
 */
export function calculateScheduleStartDate(
  closingDay: number,
  dueDay: number,
  currentInstallment = 1,
): Date {
  const today = new Date();
  const day = today.getDate();
  const month = today.getMonth() + 1;
  const year = today.getFullYear();

  // Determine the billing month that contains today's date
  let billingMonth: number;
  let billingYear: number;
  if (day <= closingDay) {
    billingMonth = month;
    billingYear = year;
  } else if (month === 12) {
    billingMonth = 1;
    billingYear = year + 1;
  } else {
    billingMonth = month + 1;
    billingYear = year;
  }

  // start_date = first day of (billingMonth - currentInstallment + 1)
  const startMonthOffset = billingMonth - currentInstallment + 1;
  const startDate = new Date(billingYear, startMonthOffset - 1, 1);

  // dueDay is accepted for future use / parity with the server-side signature
  void dueDay;

  return startDate;
}

export type Fatura = { month: number; year: number };

export function currentFatura(today: Date, closingDay: number): Fatura {
  const day = today.getDate();
  const month = today.getMonth() + 1;
  const year = today.getFullYear();
  if (day <= closingDay) return { month, year };
  return month === 12 ? { month: 1, year: year + 1 } : { month: month + 1, year };
}

export function faturaWindow(center: Fatura, back: number, forward: number): Fatura[] {
  const centerOrd = center.year * 12 + (center.month - 1);
  const out: Fatura[] = [];
  for (let ord = centerOrd - back; ord <= centerOrd + forward; ord++) {
    out.push({ month: (ord % 12) + 1, year: Math.floor(ord / 12) });
  }
  return out;
}
