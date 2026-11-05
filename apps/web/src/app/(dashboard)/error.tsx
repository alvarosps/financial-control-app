'use client';

import { RotateCcw } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';

export default function DashboardError({
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  const t = useTranslations();
  return (
    <Card surface="glass" className="mx-auto max-w-md space-y-4 p-8 text-center">
      <h2 className="text-lg font-semibold text-expense">{t('errors.title')}</h2>
      <p className="text-muted-foreground text-sm">{t('errors.description')}</p>
      <Button variant="brand" onClick={() => reset()}>
        <RotateCcw className="size-4" /> {t('common.tryAgain')}
      </Button>
    </Card>
  );
}
