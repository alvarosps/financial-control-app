import { formatCurrencyValue } from '@/lib/format';
import { cn } from '@/lib/utils';

export type AmountDisplayProps = {
  amount: number;
  currency?: string;
  showSign?: boolean;
  className?: string;
  size?: 'sm' | 'md' | 'lg';
  variant?: 'expense' | 'income' | 'neutral';
};

export function AmountDisplay({
  amount,
  currency = 'BRL',
  showSign = false,
  className,
  size = 'md',
  variant,
}: AmountDisplayProps) {
  const formatted = formatCurrencyValue(Math.abs(amount), currency);

  const isPositive = amount >= 0;
  const sign = showSign ? (isPositive ? '+' : '-') : amount < 0 ? '-' : '';

  const sizeClasses = {
    sm: 'text-sm',
    md: 'text-base',
    lg: 'text-2xl font-bold',
  };

  const colorClass =
    variant === 'income'
      ? 'text-income'
      : variant === 'expense'
        ? 'text-expense'
        : variant === 'neutral'
          ? 'text-foreground'
          : isPositive
            ? 'text-income'
            : 'text-expense';

  return (
    <span className={cn(sizeClasses[size], 'font-numeric tabular-nums', colorClass, className)}>
      {sign}
      {formatted}
    </span>
  );
}
