'use client';

import { AmountDisplay, type AmountDisplayProps } from '@/components/shared/AmountDisplay';
import { useCountUp } from '@/hooks/useCountUp';
import { formatCurrencyValue } from '@/lib/format';

/**
 * AmountDisplay with a mount-time count-up. Screen readers receive the final
 * value while animated frames stay hidden from assistive technology.
 */
export function CountUpAmount({ amount, ...props }: AmountDisplayProps) {
  const animated = useCountUp(amount);
  const currency = props.currency ?? 'BRL';
  const sign = props.showSign ? (amount >= 0 ? '+' : '-') : amount < 0 ? '-' : '';

  return (
    <span
      aria-label={`${sign}${formatCurrencyValue(Math.abs(amount), currency)}`}
      aria-live="off"
      role="status"
    >
      <span aria-hidden="true">
        <AmountDisplay amount={animated} {...props} />
      </span>
    </span>
  );
}
