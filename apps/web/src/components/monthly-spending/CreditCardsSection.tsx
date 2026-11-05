'use client';

import type { AppRouter } from '@fc/api';
import type { inferRouterOutputs } from '@trpc/server';
import { ChevronRight, CreditCard, ExternalLink, type LucideIcon } from 'lucide-react';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { useState } from 'react';

import {
  CollapsibleSpendingSection,
  SPENDING_TONES,
  type SpendingTone,
} from '@/components/monthly-spending/CollapsibleSpendingSection';
import { Badge } from '@/components/ui/badge';
import { formatCurrency } from '@/lib/format';
import { cn } from '@/lib/utils';

type CreditCardData =
  inferRouterOutputs<AppRouter>['monthlySpending']['get']['creditCards'][number];

type Props = {
  cards: CreditCardData[];
  title?: string;
  icon?: LucideIcon;
  tone?: SpendingTone;
};

function CardSubAccordion({ card, tone }: { card: CreditCardData; tone: SpendingTone }) {
  const t = useTranslations();
  const [open, setOpen] = useState(false);
  const toneClasses = SPENDING_TONES[tone];

  return (
    <div className={cn('overflow-hidden rounded-md border', toneClasses.itemBorder)}>
      <button
        type="button"
        onClick={() => setOpen(!open)}
        className={cn(
          'flex w-full items-center justify-between px-3 py-2 text-left transition-colors',
          'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50',
          toneClasses.itemHover,
        )}
        aria-expanded={open}
      >
        <div className="flex min-w-0 flex-1 items-center gap-2">
          <ChevronRight
            className={cn(
              'size-3 shrink-0 text-muted-foreground transition-transform',
              open && 'rotate-90',
            )}
          />
          {card.color && (
            <span
              className="size-2 shrink-0 rounded-full"
              style={{ backgroundColor: card.color }}
            />
          )}
          <span className="truncate text-sm font-medium">{card.cardName}</span>
          <Badge variant="secondary" className="shrink-0">
            {t('creditCards.itemsCount', { count: card.items.length })}
          </Badge>
          <Link
            href={`/credit-cards/${card.cardId}`}
            onClick={(e) => e.stopPropagation()}
            className="ml-1 inline-flex shrink-0 rounded p-1 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
            title={t('monthlySpending.viewDetails')}
          >
            <ExternalLink className="size-3" />
          </Link>
        </div>
        <span
          className={cn(
            'shrink-0 font-numeric text-sm font-semibold tabular-nums',
            toneClasses.text,
          )}
        >
          {formatCurrency(Math.abs(Number.parseFloat(card.total)))}
        </span>
      </button>

      {open && (
        <div className="divide-y divide-border/50">
          {card.items.map((item) => (
            <div
              key={item.id}
              className="flex items-center justify-between gap-2 px-4 py-2 text-sm"
            >
              <div className="min-w-0">
                <p className="truncate font-medium">{item.description}</p>
                <div className="mt-0.5 flex items-center gap-1.5">
                  {item.installmentNumber !== null && item.totalInstallments !== null && (
                    <Badge variant="outline" className="text-[10px]">
                      {item.installmentNumber}/{item.totalInstallments}
                    </Badge>
                  )}
                  {item.categoryName && (
                    <span className="text-xs text-muted-foreground">{item.categoryName}</span>
                  )}
                </div>
              </div>
              <span className={cn('shrink-0 font-numeric tabular-nums', toneClasses.text)}>
                {formatCurrency(Math.abs(Number.parseFloat(item.amount)))}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

export function CreditCardsSection({
  cards,
  title,
  icon: Icon = CreditCard,
  tone = 'cards',
}: Props) {
  const t = useTranslations();
  const resolvedTitle = title ?? t('creditCards.sectionTitle');

  if (cards.length === 0) return null;

  // Money strings from the API; parseFloat only at the display boundary.
  const total = cards.reduce((sum, c) => sum + Math.abs(Number.parseFloat(c.total)), 0);
  const itemCount = cards.reduce((sum, c) => sum + c.items.length, 0);

  return (
    <CollapsibleSpendingSection
      tone={tone}
      icon={Icon}
      title={resolvedTitle}
      badge={
        <Badge variant="secondary" className="text-[10px]">
          {t('creditCards.summary', { cards: cards.length, items: itemCount })}
        </Badge>
      }
      total={total}
      bodyClassName="space-y-1.5 px-4 pb-4"
    >
      {cards.map((card) => (
        <CardSubAccordion key={card.cardId} card={card} tone={tone} />
      ))}
    </CollapsibleSpendingSection>
  );
}
