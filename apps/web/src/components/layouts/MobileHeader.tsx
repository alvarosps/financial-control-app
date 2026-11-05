'use client';

import { Menu, ReceiptText } from 'lucide-react';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { useState } from 'react';
import { ThemeToggle } from '@/components/ui/theme-toggle';
import { MobileSidebar } from './MobileSidebar';

export function MobileHeader() {
  const t = useTranslations();
  const [open, setOpen] = useState(false);

  return (
    <>
      <header className="sticky top-0 z-40 flex h-14 items-center justify-between border-b border-glass-border bg-glass-bg px-4 backdrop-blur-md md:hidden">
        <div className="flex items-center">
          <button
            type="button"
            onClick={() => setOpen(true)}
            aria-label={t('nav.openMenu')}
            className="-ml-2 rounded-md p-2 hover:bg-accent"
          >
            <Menu className="size-5" />
          </button>
          <h1 className="ml-3 gradient-brand-text text-sm font-bold">Financial Control</h1>
        </div>
        <div className="flex items-center gap-1">
          <Link
            href="/purchases"
            aria-label={t('nav.purchases')}
            className="flex min-h-11 min-w-11 items-center justify-center rounded-lg hover:bg-accent"
          >
            <ReceiptText className="size-5" aria-hidden />
          </Link>
          <ThemeToggle />
        </div>
      </header>
      <MobileSidebar open={open} onClose={() => setOpen(false)} />
    </>
  );
}
