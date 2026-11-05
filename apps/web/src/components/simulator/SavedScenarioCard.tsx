'use client';

import type { SimScenario } from '@fc/shared';
import { Copy, GitCompare, Play, Trash2 } from 'lucide-react';
import { useLocale, useTranslations } from 'next-intl';
import { AmountDisplay } from '@/components/shared/AmountDisplay';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { cn } from '@/lib/utils';

export type SavedScenarioRow = {
  id: string;
  name: string;
  createdAt: string;
  scenario: SimScenario;
  /** Simulated ending balance, when a summary is available for the card. */
  ending?: number;
};

type SavedScenarioCardProps = {
  row: SavedScenarioRow;
  selectedForCompare?: boolean;
  duplicateDisabled?: boolean;
  onRerun: (row: SavedScenarioRow) => void;
  onDuplicate: (row: SavedScenarioRow) => void;
  onCompareToggle: (row: SavedScenarioRow) => void;
  onDelete: (row: SavedScenarioRow) => void;
};

function formatCreatedAt(iso: string, locale: string): string {
  return new Date(iso).toLocaleDateString(locale, {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
  });
}

export function SavedScenarioCard({
  row,
  selectedForCompare = false,
  duplicateDisabled = false,
  onRerun,
  onDuplicate,
  onCompareToggle,
  onDelete,
}: SavedScenarioCardProps) {
  const locale = useLocale();
  const t = useTranslations();
  const { ending } = row;

  return (
    <Card surface="solid" className={cn(selectedForCompare && 'ring-1 ring-primary')}>
      <CardHeader className="pb-0">
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0">
            <CardTitle className="truncate text-sm">{row.name}</CardTitle>
            <p className="text-xs text-muted-foreground font-numeric tabular-nums">
              {formatCreatedAt(row.createdAt, locale)}
            </p>
          </div>
          <Button
            size="icon-sm"
            variant="ghost"
            className="-mr-1 -mt-1 shrink-0 text-destructive hover:text-destructive"
            aria-label={t('simulator.savedCard.deleteAria', { name: row.name })}
            onClick={() => onDelete(row)}
          >
            <Trash2 className="size-3.5" />
          </Button>
        </div>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        {ending != null && (
          <div className="flex items-baseline justify-between gap-2">
            <span className="text-xs text-muted-foreground">
              {t('simulator.savedCard.endingLabel')}
            </span>
            <AmountDisplay amount={ending} size="sm" />
          </div>
        )}

        <div className="flex flex-wrap items-center gap-2">
          <Button size="xs" variant="outline" onClick={() => onRerun(row)}>
            <Play className="size-3" />
            {t('simulator.savedCard.rerun')}
          </Button>
          <Button
            size="xs"
            variant="outline"
            disabled={duplicateDisabled}
            onClick={() => onDuplicate(row)}
          >
            <Copy className="size-3" />
            {t('simulator.savedCard.duplicate')}
          </Button>
          <label className="ml-auto flex items-center gap-1.5 text-xs text-muted-foreground">
            <input
              type="checkbox"
              checked={selectedForCompare}
              onChange={() => onCompareToggle(row)}
              aria-label={t('simulator.savedCard.compareAria', { name: row.name })}
              className="size-3.5 accent-primary"
            />
            <GitCompare className="size-3" />
            {t('simulator.savedCard.compare')}
          </label>
        </div>
      </CardContent>
    </Card>
  );
}
