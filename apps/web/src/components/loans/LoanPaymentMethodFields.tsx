'use client';

import type { LoanPaymentMethod } from '@fc/shared';
import { useTranslations } from 'next-intl';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { trpc } from '@/lib/trpc/client';

export function LoanPaymentMethodFields({
  method,
  sourceId,
  onChange,
}: {
  method: LoanPaymentMethod | null;
  sourceId: string | null;
  onChange: (method: LoanPaymentMethod | null, sourceId: string | null) => void;
}) {
  const t = useTranslations();
  const sources = trpc.income.list.useQuery(undefined, { enabled: method === 'payroll' });
  return (
    <div className="space-y-2">
      <Label htmlFor="loan-payment-method">{t('cashForecast.paymentMethod')}</Label>
      <Select
        value={method ?? 'unreviewed'}
        onValueChange={(value) => {
          const next =
            value === 'bank_debit' || value === 'payroll' || value === 'manual' ? value : null;
          onChange(next, next === 'payroll' ? sourceId : null);
        }}
      >
        <SelectTrigger id="loan-payment-method" className="w-full">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {(['unreviewed', 'bank_debit', 'payroll', 'manual'] as const).map((value) => (
            <SelectItem key={value} value={value}>
              {t(`cashForecast.methods.${value}`)}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      {method === 'payroll' && (
        <>
          <Label htmlFor="loan-income-source">{t('cashForecast.incomeSource')}</Label>
          <Select
            value={sourceId ?? 'none'}
            onValueChange={(value) => onChange(method, value === 'none' ? null : value)}
          >
            <SelectTrigger id="loan-income-source" className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="none">{t('cashForecast.chooseLater')}</SelectItem>
              {(sources.data ?? []).map((source) => (
                <SelectItem key={source.account.id} value={source.account.id}>
                  {source.account.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <p className="text-xs text-muted-foreground">{t('cashForecast.chooseOccurrence')}</p>
          <p className="text-xs text-muted-foreground">{t('cashForecast.payrollHistoryReview')}</p>
        </>
      )}
    </div>
  );
}
