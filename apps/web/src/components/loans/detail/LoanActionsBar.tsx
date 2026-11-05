'use client';

import { ArrowLeft, CheckCircle, ChevronRight, Pencil, X } from 'lucide-react';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { PageHeader } from '@/components/shared/PageHeader';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { getLoanCategoryLabel, getLoanTypeLabel } from '@/lib/labels';

type Props = {
  accountName: string;
  paymentMethod?: string | null;
  loanCategory: string;
  loanType?: string | null;
  comment?: string | null;
  isQuitado: boolean;
  isAdvancing: boolean;
  canAdvance: boolean;
  onMarkAsPaid: () => void;
  onAdvanceMonth: () => void;
  onEdit: () => void;
  onDeactivate: () => void;
};

export function LoanActionsBar({
  accountName,
  paymentMethod,
  loanCategory,
  loanType,
  comment,
  isQuitado,
  isAdvancing,
  canAdvance,
  onMarkAsPaid,
  onAdvanceMonth,
  onEdit,
  onDeactivate,
}: Props) {
  const t = useTranslations();
  return (
    <div className="space-y-4">
      <Link href="/loans">
        <Button
          variant="ghost"
          size="sm"
          aria-label={t('components-loans-detail-loanactionsbar.back')}
        >
          <ArrowLeft className="size-4" /> {t('components-loans-detail-loanactionsbar.back')}
        </Button>
      </Link>

      <PageHeader
        title={accountName}
        actions={
          <div className="flex items-center gap-2 overflow-x-auto">
            {paymentMethod === 'payroll' ? (
              <Link href="/income">
                <Button variant="brand" size="sm">
                  {t('cashForecast.settleFromIncome')}
                </Button>
              </Link>
            ) : (
              <Button variant="brand" size="sm" onClick={onMarkAsPaid}>
                <CheckCircle className="size-3.5" />
                {t('components-loans-detail-loanactionsbar.markAsPaid')}
              </Button>
            )}
            <Button
              variant="outline"
              size="sm"
              onClick={onAdvanceMonth}
              disabled={isAdvancing || !canAdvance}
            >
              <ChevronRight className="size-3.5" />
              {isAdvancing ? t('loans.advancing') : t('loans.advanceMonth')}
            </Button>
            <Button variant="outline" size="sm" onClick={onEdit}>
              <Pencil className="size-3.5" />
              {t('components-loans-detail-loanactionsbar.edit')}
            </Button>
            <Button variant="outline" size="sm" onClick={onDeactivate}>
              <X className="size-3.5" />
              {t('loans.deactivate')}
            </Button>
          </div>
        }
      />

      <div className="flex items-center gap-2 flex-wrap">
        <Badge variant="outline">
          {t(`cashForecast.methods.${paymentMethod ?? 'unreviewed'}`)}
        </Badge>
        <Badge variant="secondary">{getLoanCategoryLabel(t, loanCategory)}</Badge>
        {loanType != null && <Badge variant="outline">{getLoanTypeLabel(t, loanType)}</Badge>}
        {isQuitado && <Badge variant="income">{t('loans.quitado')}</Badge>}
        {comment && <span className="text-sm text-muted-foreground">{comment}</span>}
      </div>
    </div>
  );
}
