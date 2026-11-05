'use client';

import { Monitor, Moon, Sun } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { useTheme } from 'next-themes';
import { useEffect, useState } from 'react';
import { cn } from '@/lib/utils';

export function ThemeToggle() {
  const t = useTranslations();
  const { theme, setTheme } = useTheme();
  const [mounted, setMounted] = useState(false);

  useEffect(() => setMounted(true), []);

  if (!mounted) {
    return <div className="h-8 w-24 rounded-lg bg-muted animate-pulse" aria-hidden="true" />;
  }

  const options = [
    { value: 'light', icon: Sun, label: t('theme.light') },
    { value: 'dark', icon: Moon, label: t('theme.dark') },
    { value: 'system', icon: Monitor, label: t('theme.system') },
  ] as const;

  return (
    <fieldset
      className="flex items-center gap-0.5 rounded-lg border-0 bg-muted p-0.5"
      aria-label={t('theme.toggle')}
    >
      {options.map(({ value, icon: Icon, label }) => (
        <button
          type="button"
          key={value}
          onClick={() => setTheme(value)}
          aria-label={t('theme.selectLabel', { theme: label })}
          aria-pressed={theme === value}
          className={cn(
            'flex items-center gap-1.5 rounded-md px-2 py-1 text-xs font-medium transition-all',
            theme === value
              ? 'bg-background text-foreground shadow-sm'
              : 'text-muted-foreground hover:text-foreground',
          )}
          title={label}
        >
          <Icon className="size-3.5" />
          <span className="hidden sm:inline">{label}</span>
        </button>
      ))}
    </fieldset>
  );
}
