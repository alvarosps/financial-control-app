import Link from 'next/link';
import { getTranslations } from 'next-intl/server';
import { buttonVariants } from '@/components/ui/button-variants';

export default async function NotFound() {
  const t = await getTranslations();
  return (
    <div className="grid min-h-screen place-items-center bg-background p-4">
      <div className="space-y-4 text-center">
        <p className="gradient-brand-text text-6xl font-bold">404</p>
        <h1 className="text-xl font-semibold">{t('notFound.title')}</h1>
        <p className="text-muted-foreground text-sm">{t('notFound.description')}</p>
        <Link href="/dashboard" className={buttonVariants({ variant: 'brand', size: 'default' })}>
          {t('notFound.backToDashboard')}
        </Link>
      </div>
    </div>
  );
}
