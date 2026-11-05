'use client';

import { useTranslations } from 'next-intl';
import type { ReactNode } from 'react';
import { ErrorBoundary, type FallbackProps } from 'react-error-boundary';

function Fallback({ resetErrorBoundary }: FallbackProps) {
  const t = useTranslations();
  return (
    <div
      role="alert"
      className="flex min-h-[40vh] flex-col items-center justify-center gap-4 p-6 text-center"
    >
      <h2 className="text-xl font-semibold">{t('errors.title')}</h2>
      <p className="max-w-md text-sm text-muted-foreground">{t('errors.description')}</p>
      <button
        type="button"
        onClick={resetErrorBoundary}
        className="rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90"
      >
        {t('common.tryAgain')}
      </button>
    </div>
  );
}

export function GlobalErrorBoundary({ children }: { children: ReactNode }) {
  return <ErrorBoundary FallbackComponent={Fallback}>{children}</ErrorBoundary>;
}
