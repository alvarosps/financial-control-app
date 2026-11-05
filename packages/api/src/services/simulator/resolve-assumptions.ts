import { Money, type ResolvedDelta } from '@fc/domain';
import type { SimAssumptions } from '@fc/shared';
import { convertIncomeToBrl } from '../../lib/fx.ts';
import type { ForecastMonth } from '../forecast-context.service.ts';

export function resolveAssumptions(
  months: ForecastMonth[],
  assumptions: SimAssumptions,
): ResolvedDelta {
  return {
    leverId: 'forecast-assumptions',
    events: [],
    byMonth: months.map((month) => {
      let incomeDelta = Money.fromNumber(month.familyRemaining, 'BRL').multiply(
        (assumptions.familyReceiptPercent - 100) / 100,
      );
      for (const source of month.sources) {
        for (const occurrence of source.occurrences) {
          const rate = assumptions.exchangeRates?.[occurrence.currency];
          if (
            !rate ||
            occurrence.currency === 'BRL' ||
            (occurrence.isPaid && occurrence.settlementSource !== 'date_assumed')
          )
            continue;
          const converted = convertIncomeToBrl(
            Money.fromString(occurrence.amount, occurrence.currency),
            occurrence.currency,
            rate,
            null,
            source.conversionFeePercent,
          );
          incomeDelta = incomeDelta.add(
            converted.subtract(Money.fromString(occurrence.amountBrl ?? '0', 'BRL')),
          );
        }
      }
      return {
        month: month.month,
        year: month.year,
        incomeDelta: incomeDelta.toDbString(),
        expenseDelta: '0.00',
      };
    }),
  };
}
