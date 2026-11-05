'use client';

import { useTranslations } from 'next-intl';
import { Button } from '../ui/button';

export function ErrorAlert({ message, onRetry }: { message: string; onRetry?: () => void }) {
  const t = useTranslations();
  return (
    <div className="rounded-xl glass border-expense/20 p-4 text-sm text-expense" role="alert">
      <p>
        {t('components-shared-erroralert.error')} {message}
      </p>
      {onRetry && (
        <Button variant="ghost" size="sm" onClick={onRetry} className="mt-2 text-expense underline">
          {t('common.tryAgain')}
        </Button>
      )}
    </div>
  );
}
