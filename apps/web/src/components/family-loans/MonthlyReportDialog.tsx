'use client';

import { Copy, FileText, Loader2 } from 'lucide-react';
import { useLocale, useTranslations } from 'next-intl';
import { useEffect, useMemo, useState } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { copyText } from '@/lib/clipboard';
import {
  buildFamilyLoanMonthlyReport,
  type FamilyLoanMonthlyReport,
} from '@/lib/family-loans/build-monthly-report';
import { trpc } from '@/lib/trpc/client';

type Period = {
  month: number;
  year: number;
};

type Props = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  configId: string;
  initialMonth: number;
  initialYear: number;
  cardNameMap: Map<string, string>;
};

function periodValue(month: number, year: number): string {
  return `${year.toString().padStart(4, '0')}-${month.toString().padStart(2, '0')}`;
}

function parsePeriod(value: string): Period | null {
  const match = /^(\d{4})-(\d{2})$/.exec(value);
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  if (year < 2020 || year > 2100 || month < 1 || month > 12) return null;
  return { month, year };
}

export function MonthlyReportDialog({
  open,
  onOpenChange,
  configId,
  initialMonth,
  initialYear,
  cardNameMap,
}: Props) {
  const locale = useLocale();
  const t = useTranslations('components-family-loans-monthlyreportdialog');
  const initialPeriod = periodValue(initialMonth, initialYear);
  const [draftPeriod, setDraftPeriod] = useState(initialPeriod);
  const [reportPeriod, setReportPeriod] = useState<Period | null>(null);
  const [validationError, setValidationError] = useState(false);

  useEffect(() => {
    if (!open) {
      setDraftPeriod(initialPeriod);
      setReportPeriod(null);
      setValidationError(false);
    }
  }, [initialPeriod, open]);

  const queryPeriod = reportPeriod ?? { month: initialMonth, year: initialYear };
  const reportQuery = trpc.familyLoan.getMonthlyTotal.useQuery(
    {
      configId,
      month: queryPeriod.month,
      year: queryPeriod.year,
    },
    {
      enabled: open && reportPeriod !== null,
      retry: false,
    },
  );

  const preview = useMemo(() => {
    if (!reportPeriod || !reportQuery.data || reportQuery.isFetching) return null;
    const monthly = reportQuery.data;
    const labels: FamilyLoanMonthlyReport['labels'] = {
      description: t('columns.description'),
      value: t('columns.value'),
      installment: t('columns.installment'),
      sections: {
        cards: { title: t('sections.cards.title'), total: t('sections.cards.total') },
        installments: {
          title: t('sections.installments.title'),
          total: t('sections.installments.total'),
        },
        fixedCharges: {
          title: t('sections.fixedCharges.title'),
          total: t('sections.fixedCharges.total'),
        },
        oneTimeCharges: {
          title: t('sections.oneTimeCharges.title'),
          total: t('sections.oneTimeCharges.total'),
        },
        discounts: {
          title: t('sections.discounts.title'),
          total: t('sections.discounts.total'),
        },
      },
    };
    const toItem = (item: (typeof monthly.items.installments)[number]) => ({
      description: item.description,
      amount: item.amount,
      installmentNumber: item.installmentNumber,
      totalInstallments: item.totalInstallments,
    });
    const cardsWithCharges = monthly.borrowedCardBreakdown.filter(
      (card) => Math.abs(card.total) >= 0.005,
    );

    return buildFamilyLoanMonthlyReport({
      locale,
      month: reportPeriod.month,
      year: reportPeriod.year,
      labels,
      totals: {
        grandTotal: monthly.total,
        cards: monthly.borrowedCardTotal,
        installments: monthly.installments,
        fixedCharges: monthly.fixedCharges,
        oneTimeCharges: monthly.oneTimeCharges,
        discounts: monthly.discounts,
      },
      cards: cardsWithCharges.map((card) => ({
        description:
          cardNameMap.get(card.creditCardAccountId) ??
          `${t('unnamedCard')} ${card.creditCardAccountId.slice(0, 6)}`,
        amount: card.total,
      })),
      installments: monthly.items.installments.map(toItem),
      fixedCharges: monthly.items.fixedCharges.map(toItem),
      oneTimeCharges: monthly.items.expenses.map(toItem),
      discounts: monthly.items.discounts.map(toItem),
    });
  }, [cardNameMap, reportPeriod, reportQuery.data, reportQuery.isFetching, t, locale]);

  const handleGenerate = () => {
    const parsed = parsePeriod(draftPeriod);
    if (!parsed) {
      setValidationError(true);
      setReportPeriod(null);
      return;
    }
    setValidationError(false);
    if (reportPeriod?.month === parsed.month && reportPeriod.year === parsed.year) {
      void reportQuery.refetch();
      return;
    }
    setReportPeriod(parsed);
  };

  const handleCopy = async () => {
    if (!preview) return;
    try {
      await copyText(preview);
      toast.success(t('copied'));
    } catch {
      toast.error(t('copyFailed'));
    }
  };

  const handleOpenChange = (nextOpen: boolean) => {
    if (!nextOpen) {
      setDraftPeriod(initialPeriod);
      setReportPeriod(null);
      setValidationError(false);
    }
    onOpenChange(nextOpen);
  };

  const isEmpty =
    reportQuery.data != null &&
    reportQuery.data.items.installments.length === 0 &&
    reportQuery.data.items.fixedCharges.length === 0 &&
    reportQuery.data.items.expenses.length === 0 &&
    reportQuery.data.items.discounts.length === 0 &&
    reportQuery.data.borrowedCardBreakdown.every((card) => Math.abs(card.total) < 0.005);

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle>{t('title')}</DialogTitle>
          <DialogDescription>{t('description')}</DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="family-loan-report-period">{t('period')}</Label>
            <div className="flex flex-col gap-2 sm:flex-row sm:items-start">
              <Input
                id="family-loan-report-period"
                type="month"
                min="2020-01"
                max="2100-12"
                value={draftPeriod}
                autoFocus
                aria-invalid={validationError}
                onChange={(event) => {
                  setDraftPeriod(event.target.value);
                  setReportPeriod(null);
                  setValidationError(false);
                }}
              />
              <div className="flex flex-col gap-2 sm:shrink-0">
                <Button type="button" onClick={handleGenerate} disabled={reportQuery.isFetching}>
                  {reportQuery.isFetching ? (
                    <Loader2 className="size-4 animate-spin" aria-hidden="true" />
                  ) : (
                    <FileText className="size-4" aria-hidden="true" />
                  )}
                  {reportQuery.isFetching ? t('generating') : t('generate')}
                </Button>
                <Button type="button" onClick={handleCopy} disabled={!preview}>
                  <Copy className="size-4" aria-hidden="true" />
                  {t('copy')}
                </Button>
              </div>
            </div>
          </div>

          {validationError && (
            <p className="text-sm text-expense" role="alert">
              {t('invalidPeriod')}
            </p>
          )}

          {reportQuery.error && reportPeriod && (
            <p className="text-sm text-expense" role="alert">
              {t('loadError')} {reportQuery.error.message}
            </p>
          )}

          {preview && (
            <div className="space-y-2">
              <div className="flex items-center justify-between gap-2">
                <p className="text-sm font-medium">{t('preview')}</p>
                {isEmpty && <span className="text-xs text-muted-foreground">{t('empty')}</span>}
              </div>
              <pre
                id="family-loan-report-preview"
                className="min-h-48 overflow-x-auto rounded-lg border bg-muted/40 p-4 font-mono text-xs leading-relaxed whitespace-pre"
              >
                {preview}
              </pre>
            </div>
          )}
        </div>

        <DialogFooter>
          <Button type="button" variant="outline" onClick={() => handleOpenChange(false)}>
            {t('close')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
