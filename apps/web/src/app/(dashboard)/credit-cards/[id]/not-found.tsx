import Link from 'next/link';
import { getTranslations } from 'next-intl/server';
import { buttonVariants } from '@/components/ui/button-variants';

export default async function CreditCardNotFound() {
  const t = await getTranslations();
  return (
    <div className="grid place-items-center py-24">
      <div className="space-y-4 text-center">
        <h1 className="text-xl font-semibold">{t('notFound.cardMissing')}</h1>
        <Link
          href="/credit-cards"
          className={buttonVariants({ variant: 'brand', size: 'default' })}
        >
          {t('notFound.backToDashboard')}
        </Link>
      </div>
    </div>
  );
}
