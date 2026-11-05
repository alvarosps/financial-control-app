import { Calendar } from 'lucide-react';
import type * as React from 'react';
import { cn } from '@/lib/utils';

export type CreditCardVisualProps = {
  name: string;
  last4?: string;
  /** Payment due day of the card (shown bottom-right with a calendar icon). */
  dueDay?: number;
  /** Short prefix before the due day, e.g. "venc." (i18n by the caller). */
  dueLabel?: string;
  /** Any CSS color (OKLCH recommended). Drives the card face gradient. */
  color?: string;
  bill?: React.ReactNode;
  status?: React.ReactNode;
  /** e.g. "Fatura: Junho 2026" — rendered above the bill amount. */
  billMonthLabel?: string;
  /** 0–100+ ; when set, renders a thin limit-usage bar (clamped to 100). */
  limitPct?: number;
  /** Short word after the percentage, e.g. "limite" (i18n by the caller). */
  limitLabel?: string;
  className?: string;
};

export function CreditCardVisual({
  name,
  last4,
  dueDay,
  dueLabel,
  color,
  bill,
  status,
  billMonthLabel,
  limitPct,
  limitLabel,
  className,
}: CreditCardVisualProps) {
  const clampedPct = limitPct != null ? Math.min(100, Math.max(0, limitPct)) : null;
  return (
    <div
      data-slot="credit-card-visual"
      style={color ? ({ '--card-color': color } as React.CSSProperties) : undefined}
      className={cn(
        'relative flex min-h-[140px] flex-col justify-between overflow-hidden rounded-2xl p-4 text-white shadow-lg',
        color
          ? 'bg-[linear-gradient(135deg,var(--card-color),color-mix(in_oklch,var(--card-color),black_32%))]'
          : 'gradient-brand',
        className,
      )}
    >
      <div
        aria-hidden
        className="absolute inset-0 bg-[radial-gradient(80%_60%_at_85%_8%,oklch(1_0_0/0.22),transparent_60%)]"
      />
      <div className="relative z-10 flex items-start justify-between gap-2">
        <span className="text-xs font-extrabold uppercase tracking-[0.12em]">{name}</span>
        {status}
      </div>
      <div className="relative z-10 space-y-1.5">
        {billMonthLabel && (
          <span className="block text-[11px] font-medium text-white/85">{billMonthLabel}</span>
        )}
        {bill}
        {clampedPct != null && (
          <div className="space-y-0.5">
            <div
              data-testid="cc-limit-bar"
              className="h-1.5 w-full overflow-hidden rounded-full bg-white/25"
            >
              <div
                className="h-full rounded-full bg-white/85"
                style={{ width: `${clampedPct}%` }}
              />
            </div>
            <span className="block text-right text-[10px] text-white/80 font-numeric tabular-nums">
              {Math.round(limitPct ?? 0)}%{limitLabel ? ` ${limitLabel}` : ''}
            </span>
          </div>
        )}
      </div>
      <div className="relative z-10 flex items-center justify-between text-[10px] opacity-90">
        {last4 && <span className="tracking-widest font-numeric tabular-nums">•••• {last4}</span>}
        {dueDay != null && (
          <span
            data-slot="cc-due-day"
            className="inline-flex items-center gap-1 font-numeric tabular-nums"
          >
            <Calendar className="size-3" aria-hidden />{' '}
            {dueLabel ? `${dueLabel} ${dueDay}` : dueDay}
          </span>
        )}
      </div>
    </div>
  );
}
