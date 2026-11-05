'use client';

import { Languages } from 'lucide-react';
import { useLocale, useTranslations } from 'next-intl';
import { useTransition } from 'react';
import { toast } from 'sonner';
import { setLocale } from '@/i18n/actions';
import { isLocale } from '@/i18n/config';

export function LanguageSwitcher() {
  const locale = useLocale();
  const t = useTranslations('language');
  const [pending, startTransition] = useTransition();

  return (
    <label className="flex min-h-11 items-center gap-2 text-sm">
      <Languages className="size-4 shrink-0" aria-hidden />
      <select
        aria-label={t('label')}
        value={locale}
        disabled={pending}
        className="min-h-11 min-w-0 rounded-md border border-input bg-background px-2 text-foreground disabled:opacity-50"
        onChange={(event) => {
          const nextLocale = event.target.value;
          if (!isLocale(nextLocale) || nextLocale === locale) return;
          startTransition(async () => {
            try {
              await setLocale(nextLocale);
            } catch {
              toast.error(t('saveError'));
            }
          });
        }}
      >
        <option value="pt-BR" lang="pt-BR">
          Português
        </option>
        <option value="en" lang="en">
          English
        </option>
      </select>
    </label>
  );
}
