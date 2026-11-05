import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { Card, CardContent } from '@/components/ui/card';
import { cardColor } from '@/lib/card-color';

type AccountItem = {
  id: string;
  name: string;
};

type Props = {
  cards: AccountItem[];
};

export function AdditionalCards({ cards }: Props) {
  const t = useTranslations();
  if (cards.length === 0) return null;

  return (
    <Card>
      <CardContent className="pt-4 space-y-3">
        <h2 className="text-base font-semibold">
          {t('components-credit-cards-detail-additionalcards.additionalCards')}
        </h2>
        <div className="space-y-1">
          {cards.map((card) => (
            <Link
              key={card.id}
              href={`/credit-cards/${card.id}`}
              className="flex items-center gap-3 rounded-lg px-3 py-2 text-sm hover:bg-glass-hover-bg transition-all"
            >
              <span
                className="h-3 w-3 shrink-0 rounded-full"
                style={{ backgroundColor: cardColor(card.id) }}
                aria-hidden="true"
              />
              <span className="font-medium">{card.name}</span>
            </Link>
          ))}
        </div>
      </CardContent>
    </Card>
  );
}
