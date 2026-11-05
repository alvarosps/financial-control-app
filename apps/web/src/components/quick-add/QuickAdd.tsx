'use client';

import { Plus } from 'lucide-react';
import { usePathname } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { useMemo, useState } from 'react';
import { orderCategoriesByUsage } from '@/lib/category-usage';
import { selectQuickAddAccounts } from '@/lib/quick-add-selectors';
import { trpc } from '@/lib/trpc/client';
import { QuickAddSheet } from './QuickAddSheet';

export function QuickAdd({ inline = false }: { inline?: boolean }) {
  const t = useTranslations();
  const pathname = usePathname();
  const [open, setOpen] = useState(false);
  const now = useMemo(() => new Date(), []);

  const { data: accounts } = trpc.account.list.useQuery(undefined, { enabled: open });
  const { data: walletsOverview } = trpc.account.walletsOverview.useQuery(undefined, {
    enabled: open,
  });
  const { data: categoryList } = trpc.category.list.useQuery(undefined, { enabled: open });
  const { data: cardConfigList } = trpc.creditCard.listConfigs.useQuery(undefined, {
    enabled: open,
  });
  const { data: monthTransactions } = trpc.transaction.list.useQuery(
    { month: now.getMonth() + 1, year: now.getFullYear() },
    { enabled: open },
  );

  const accountRows = useMemo(
    () =>
      (Array.isArray(accounts) ? accounts : []).map((account) => ({
        id: account.id,
        name: account.name,
        type: account.type,
        isActive: account.isActive,
      })),
    [accounts],
  );
  const { cards, expenseAccountId, cardExpenseAccountId } = useMemo(
    () => selectQuickAddAccounts(accountRows),
    [accountRows],
  );
  const wallets = useMemo(
    () =>
      (walletsOverview?.wallets ?? []).map((wallet) => ({
        id: wallet.id,
        name: wallet.name,
        isDefaultWallet: wallet.isDefaultWallet,
      })),
    [walletsOverview],
  );
  const categories = useMemo(
    () =>
      orderCategoriesByUsage(
        (categoryList ?? [])
          .filter((category) => category.type === 'expense')
          .map((category) => ({ id: category.id, name: category.name })),
        (Array.isArray(monthTransactions) ? monthTransactions : []).map((transaction) => ({
          categoryId: transaction.categoryId,
        })),
      ),
    [categoryList, monthTransactions],
  );
  const cardConfigs = useMemo(
    () =>
      (cardConfigList ?? []).map((config) => ({
        accountId: config.accountId,
        closingDay: config.closingDay,
      })),
    [cardConfigList],
  );

  if (!inline && pathname === '/purchases') return null;
  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        aria-label={t('quickAdd.open')}
        className={
          inline
            ? 'gradient-brand flex min-h-11 items-center gap-2 rounded-lg px-4 text-sm font-medium text-white'
            : 'gradient-brand fixed right-4 bottom-4 z-40 flex size-14 items-center justify-center rounded-full text-white shadow-lg transition-transform active:scale-95 md:hidden'
        }
      >
        <Plus className="size-6" aria-hidden />
        {inline && t('purchases.newPurchase')}
      </button>
      <QuickAddSheet
        open={open}
        onOpenChange={setOpen}
        wallets={inline ? [] : wallets}
        cards={cards}
        cardConfigs={cardConfigs}
        categories={categories}
        expenseAccountId={expenseAccountId}
        cardExpenseAccountId={cardExpenseAccountId}
      />
    </>
  );
}
