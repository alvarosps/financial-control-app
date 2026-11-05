'use client';

// src/components/credit-cards/detail/CreditCardHeader.tsx
import { ArrowLeft, FileUp, Plus, Settings } from 'lucide-react';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { PageHeader } from '@/components/shared/PageHeader';
import { Button } from '@/components/ui/button';
import { formatCurrency } from '@/lib/format';
import { toDisplayNumber } from '@/lib/parse';

type Props = {
  cardName: string;
  closingDay?: number;
  dueDay?: number;
  creditLimit?: string | null;
  onAddInstallment: () => void;
  onAddExpense: () => void;
  onAddRefund: () => void;
  onAddAdditionalCard: () => void;
  onEditCard: () => void;
  onImportFatura: () => void;
};

export function CreditCardHeader({
  cardName,
  closingDay,
  dueDay,
  creditLimit,
  onAddInstallment,
  onAddExpense,
  onAddRefund,
  onAddAdditionalCard,
  onEditCard,
  onImportFatura,
}: Props) {
  const t = useTranslations();
  const limitParsed = creditLimit ? toDisplayNumber(creditLimit) : null;
  const limitFormatted =
    limitParsed != null && !Number.isNaN(limitParsed) ? formatCurrency(limitParsed) : null;

  const subtitle =
    closingDay != null && dueDay != null
      ? t('components-credit-cards-detail-creditcardheader.cycle', { closingDay, dueDay }) +
        (limitFormatted
          ? t('components-credit-cards-detail-creditcardheader.limitSuffix', {
              limit: limitFormatted,
            })
          : '')
      : undefined;

  return (
    <div className="space-y-4">
      <Link href="/credit-cards">
        <Button
          variant="ghost"
          size="sm"
          aria-label={t('components-credit-cards-detail-creditcardheader.back')}
        >
          <ArrowLeft className="size-4" />{' '}
          {t('components-credit-cards-detail-creditcardheader.back')}
        </Button>
      </Link>

      <PageHeader
        title={cardName}
        subtitle={subtitle}
        actions={
          <div className="flex items-center gap-2 overflow-x-auto">
            <Button variant="brand" size="sm" onClick={onAddInstallment}>
              <Plus className="size-3.5" />{' '}
              {t('components-credit-cards-detail-creditcardheader.installment')}
            </Button>
            <Button variant="outline" size="sm" onClick={onAddExpense}>
              <Plus className="size-3.5" />{' '}
              {t('components-credit-cards-detail-creditcardheader.expense')}
            </Button>
            <Button variant="outline" size="sm" onClick={onAddRefund}>
              <Plus className="size-3.5" />{' '}
              {t('components-credit-cards-detail-creditcardheader.refund')}
            </Button>
            <Button variant="outline" size="sm" onClick={onImportFatura}>
              <FileUp className="size-3.5" />{' '}
              {t('components-credit-cards-detail-creditcardheader.importFatura')}
            </Button>
            <Button variant="ghost" size="sm" onClick={onAddAdditionalCard}>
              <Plus className="size-3.5" />{' '}
              {t('components-credit-cards-detail-creditcardheader.additionalCard')}
            </Button>
            <Button
              variant="ghost"
              size="sm"
              onClick={onEditCard}
              aria-label={t('components-credit-cards-detail-creditcardheader.editCard')}
            >
              <Settings className="size-3.5" />
            </Button>
          </div>
        }
      />
    </div>
  );
}
