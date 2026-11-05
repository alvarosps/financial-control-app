'use client';

import { GLOBAL_ERROR_COPY } from '@fc/shared';

import { Button } from '@/components/ui/button';

export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <html lang="pt-BR">
      <body className="grid min-h-screen place-items-center bg-background p-4 font-sans antialiased">
        <div className="w-full max-w-md space-y-4 text-center">
          <h1 className="gradient-brand-text text-2xl font-bold">{GLOBAL_ERROR_COPY.title}</h1>
          <p className="text-muted-foreground text-sm">
            {GLOBAL_ERROR_COPY.description}
            {error.digest ? ` (${error.digest})` : ''}
          </p>
          <Button variant="brand" onClick={() => reset()}>
            {GLOBAL_ERROR_COPY.retry}
          </Button>
        </div>
      </body>
    </html>
  );
}
