'use client';

import type { ProjectionAlerts } from '@fc/domain';
import { useLocale, useTranslations } from 'next-intl';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent } from '@/components/ui/card';
import { formatCurrency } from '@/lib/format';
import { monthYearLabel } from '@/lib/labels';

export type SimulatorAlertsProps = {
  alerts: ProjectionAlerts;
};

export function SimulatorAlerts({ alerts }: SimulatorAlertsProps) {
  const locale = useLocale();
  const t = useTranslations();
  const overdraft = alerts.firstNegativeMonthSimulated;

  return (
    <Card surface="glass">
      <CardContent className="flex flex-wrap items-center gap-2 py-4">
        {overdraft ? (
          <Badge variant="expense" role="status">
            {t('simulator.alerts.overdraftSimulated', {
              month: monthYearLabel(overdraft, 4, locale),
            })}
          </Badge>
        ) : (
          <Badge variant="income" role="status">
            {t('simulator.alerts.noOverdraft')}
          </Badge>
        )}
        <Badge variant={alerts.troughSimulated.balance < 0 ? 'expense' : 'info'} role="status">
          {t('simulator.alerts.troughSimulated', {
            amount: formatCurrency(alerts.troughSimulated.balance),
            month: monthYearLabel(alerts.troughSimulated, 4, locale),
          })}
        </Badge>
      </CardContent>
    </Card>
  );
}
