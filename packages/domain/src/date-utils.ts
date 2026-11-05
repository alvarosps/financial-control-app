export function addMonths(
  month: number,
  year: number,
  count: number,
): { month: number; year: number } {
  const total = year * 12 + (month - 1) + count;
  const m = ((total % 12) + 12) % 12;
  const y = Math.floor(total / 12);
  return { month: m + 1, year: y };
}

export function getCurrentPeriod(now: Date = new Date()): { month: number; year: number } {
  return { month: now.getMonth() + 1, year: now.getFullYear() };
}
