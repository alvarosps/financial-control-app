'use client';

import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { Card, CardContent } from '@/components/ui/card';
import { cardColor } from '@/lib/card-color';
import { formatCurrency } from '@/lib/format';

type BreakdownItem = {
  cardId: string;
  name: string;
  color?: string | null;
  total: number;
  isPrincipal: boolean;
};

type Props = {
  total: number;
  breakdown: BreakdownItem[];
};

function SegmentContent({
  name,
  total,
  pct,
  color,
}: {
  name: string;
  total: number;
  pct: number;
  color: string;
}) {
  return (
    <div
      className="flex h-full min-w-0 flex-col gap-0.5 rounded-lg px-3 py-2 text-white"
      style={{ backgroundColor: color }}
    >
      <span className="truncate text-xs font-semibold">{name}</span>
      <span className="text-sm font-bold font-numeric tabular-nums">{formatCurrency(total)}</span>
      <span className="text-[10px] text-white/80 font-numeric tabular-nums">{pct}%</span>
    </div>
  );
}

export function ConsolidatedBillCard({ total, breakdown }: Props) {
  const t = useTranslations();
  const safeTotal = total > 0 ? total : 0;

  return (
    <Card>
      <CardContent className="pt-4 space-y-3">
        <div className="flex items-center justify-between">
          <h2 className="text-base font-semibold">
            {t('components-credit-cards-detail-consolidatedbillcard.title')}
          </h2>
          <span className="text-lg font-bold font-numeric tabular-nums">
            {formatCurrency(safeTotal)}
          </span>
        </div>

        {/* Full-width total line */}
        <div className="h-2 w-full overflow-hidden rounded-full bg-muted">
          <div className="h-full w-full gradient-brand" />
        </div>

        {/* Proportional segments per card (flex-grow ∝ each card's total) */}
        <div className="flex gap-1">
          {breakdown.map((item) => {
            const pct = safeTotal > 0 ? Math.round((item.total / safeTotal) * 100) : 0;
            const segmentColor = item.color ?? cardColor(item.cardId);
            const style = {
              flexGrow: Math.max(item.total, 0.0001),
              flexBasis: 0,
              minWidth: '4rem',
            };
            return item.isPrincipal ? (
              <div key={item.cardId} style={style}>
                <SegmentContent
                  name={item.name}
                  total={item.total}
                  pct={pct}
                  color={segmentColor}
                />
              </div>
            ) : (
              <Link
                key={item.cardId}
                href={`/credit-cards/${item.cardId}`}
                style={style}
                className="block motion-safe:transition-transform motion-safe:hover:-translate-y-0.5"
              >
                <SegmentContent
                  name={item.name}
                  total={item.total}
                  pct={pct}
                  color={segmentColor}
                />
              </Link>
            );
          })}
        </div>
      </CardContent>
    </Card>
  );
}
