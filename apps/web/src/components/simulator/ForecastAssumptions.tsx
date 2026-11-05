'use client';

import type { SimAssumptions } from '@fc/shared';
import { useTranslations } from 'next-intl';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';

export function ForecastAssumptions({
  value,
  onChange,
  currencies,
}: {
  value: SimAssumptions;
  onChange: (value: SimAssumptions) => void;
  currencies: string[];
}) {
  const t = useTranslations();
  return (
    <Card>
      <CardContent className="space-y-3">
        <Label htmlFor="family-percent">{t('cashForecast.receiptPercent')}</Label>
        <Input
          id="family-percent"
          type="number"
          min="0"
          max="100"
          value={value.familyReceiptPercent}
          onChange={(event) => {
            const percent = Number(event.target.value);
            if (Number.isFinite(percent) && percent >= 0 && percent <= 100)
              onChange({ ...value, familyReceiptPercent: percent });
          }}
        />
        <Button
          variant="outline"
          size="sm"
          onClick={() => onChange({ ...value, familyReceiptPercent: 0 })}
        >
          {t('cashForecast.noReceipts')}
        </Button>
        <p className="text-xs text-muted-foreground">{t('cashForecast.variableSpendHint')}</p>
        {currencies
          .filter((currency) => ['USD', 'EUR', 'GBP'].includes(currency))
          .map((currency) => (
            <div key={currency}>
              <Label htmlFor={`scenario-rate-${currency}`}>
                {t('cashForecast.scenarioFx', { currency })}
              </Label>
              <Input
                id={`scenario-rate-${currency}`}
                inputMode="decimal"
                placeholder={t('cashForecast.keepConfigured')}
                value={value.exchangeRates?.[currency] ?? ''}
                onChange={(event) => {
                  const rate = event.target.value.replace(',', '.');
                  const rates = { ...value.exchangeRates };
                  if (rate === '') delete rates[currency];
                  else if (
                    /^\d+(\.\d{0,6})?$/.test(rate) &&
                    Number(rate) > 0 &&
                    Number(rate) <= 10000
                  )
                    rates[currency] = rate.endsWith('.') ? `${rate}0` : rate;
                  else return;
                  onChange({ ...value, exchangeRates: rates });
                }}
              />
            </div>
          ))}
      </CardContent>
    </Card>
  );
}
