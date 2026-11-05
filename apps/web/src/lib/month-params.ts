export type MonthYear = { month: number; year: number };

type RawParam = string | string[] | null | undefined;

function firstValue(value: RawParam): string | null {
  return Array.isArray(value) ? (value[0] ?? null) : (value ?? null);
}

function parseIntegerInRange(value: RawParam, min: number, max: number): number | null {
  const raw = firstValue(value);
  if (!raw) return null;

  const parsed = Number(raw);
  return Number.isInteger(parsed) && parsed >= min && parsed <= max ? parsed : null;
}

export function parseMonthParam(value: RawParam): number | null {
  return parseIntegerInRange(value, 1, 12);
}

export function parseYearParam(value: RawParam): number | null {
  return parseIntegerInRange(value, 2000, 2100);
}

export function currentMonthYear(timeZone = 'America/Sao_Paulo'): MonthYear {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
  }).formatToParts(new Date());

  return {
    month: Number(parts.find((part) => part.type === 'month')?.value),
    year: Number(parts.find((part) => part.type === 'year')?.value),
  };
}

export type MonthYearSearchParams = { month?: string | string[]; year?: string | string[] };

export function resolveMonthYear(
  searchParams: MonthYearSearchParams,
  fallback: MonthYear = currentMonthYear(),
): MonthYear {
  return {
    month: parseMonthParam(searchParams.month) ?? fallback.month,
    year: parseYearParam(searchParams.year) ?? fallback.year,
  };
}
