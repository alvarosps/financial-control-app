type Frequency =
  | 'once'
  | 'weekly'
  | 'biweekly'
  | 'monthly'
  | 'bimonthly'
  | 'quarterly'
  | 'semiannual'
  | 'annual';

type OccurrenceDate = {
  date: Date;
  occurrenceNumber: number;
};

type ComputeInput = {
  frequency: Frequency;
  startDate: Date;
  dueDay: number | null;
  totalOccurrences: number | null;
  startingOccurrence: number;
  horizonMonths: number;
  endDate?: Date;
};

function getMonthInterval(frequency: Frequency): number {
  switch (frequency) {
    case 'monthly':
      return 1;
    case 'bimonthly':
      return 2;
    case 'quarterly':
      return 3;
    case 'semiannual':
      return 6;
    case 'annual':
      return 12;
    default:
      return 0;
  }
}

function clampDay(year: number, month: number, day: number): Date {
  const lastDay = new Date(year, month + 1, 0).getDate();
  return new Date(year, month, Math.min(day, lastDay));
}

export function computeOccurrenceDates(input: ComputeInput): OccurrenceDate[] {
  const {
    frequency,
    startDate,
    dueDay,
    totalOccurrences,
    startingOccurrence,
    horizonMonths,
    endDate,
  } = input;
  const results: OccurrenceDate[] = [];

  const totalHorizonMonths = startDate.getMonth() + horizonMonths;
  const horizonEnd = clampDay(
    startDate.getFullYear() + Math.floor(totalHorizonMonths / 12),
    ((totalHorizonMonths % 12) + 12) % 12,
    startDate.getDate(),
  );

  const remainingOccurrences =
    totalOccurrences !== null ? totalOccurrences - startingOccurrence + 1 : Infinity;

  if (frequency === 'once') {
    if (remainingOccurrences > 0 && startDate < horizonEnd && (!endDate || startDate <= endDate)) {
      results.push({ date: new Date(startDate), occurrenceNumber: startingOccurrence });
    }
    return results;
  }

  if (frequency === 'weekly' || frequency === 'biweekly') {
    const dayInterval = frequency === 'weekly' ? 7 : 14;
    let current = new Date(startDate);
    let occNum = startingOccurrence;

    while (current < horizonEnd && results.length < remainingOccurrences) {
      if (endDate && current > endDate) break;
      results.push({ date: new Date(current), occurrenceNumber: occNum });
      occNum++;
      current = new Date(current.getTime() + dayInterval * 24 * 60 * 60 * 1000);
    }
    return results;
  }

  // Monthly-based frequencies
  const interval = getMonthInterval(frequency);
  if (interval === 0) return results;

  const day = dueDay ?? startDate.getDate();
  let monthOffset = 0;
  let occNum = startingOccurrence;

  while (results.length < remainingOccurrences) {
    if (monthOffset >= horizonMonths) break;

    const targetMonth = startDate.getMonth() + monthOffset;
    const targetYear = startDate.getFullYear() + Math.floor(targetMonth / 12);
    const normalizedMonth = ((targetMonth % 12) + 12) % 12;

    const date = clampDay(targetYear, normalizedMonth, day);

    if (endDate && date > endDate) break;

    results.push({ date, occurrenceNumber: occNum });
    occNum++;
    monthOffset += interval;
  }

  return results;
}
