'use client';

import { CreditCard, MoreVertical, Pencil, SlidersHorizontal, Wallet } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { useState } from 'react';
import { AdjustBalanceDialog } from '@/components/accounts/AdjustBalanceDialog';
import { EditWalletDialog } from '@/components/accounts/EditWalletDialog';
import { AmountDisplay } from '@/components/shared/AmountDisplay';
import { EmptyState } from '@/components/shared/EmptyState';
import { PageHeader } from '@/components/shared/PageHeader';
import { SkeletonCard } from '@/components/shared/SkeletonCard';
import { StatCard } from '@/components/shared/StatCard';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { useAutoCreditToast } from '@/hooks/useAutoCreditToast';
import { usePageTitle } from '@/hooks/usePageTitle';
import { formatCurrency } from '@/lib/format';
import { skeletonKeys } from '@/lib/skeleton-keys';
import { trpc } from '@/lib/trpc/client';
import { walletOverdraft, walletsTotals } from '@/lib/wallet-summary';

type WalletRow = {
  id: string;
  name: string;
  currency: string;
  isDefaultWallet: boolean;
  overdraftLimit: string | null;
  openingBalance: string;
  cash: number;
  cashQuality?: {
    legacyMovementCount: number;
    unresolvedMovementCount: number;
    assumedDelta: number;
    anchorBasis: string;
  };
};

export function AccountsClient() {
  const t = useTranslations();
  usePageTitle(t('pageTitles.accounts'));

  const { data, isLoading, error } = trpc.account.walletsOverview.useQuery();
  const [editWallet, setEditWallet] = useState<WalletRow | null>(null);
  const [adjustWallet, setAdjustWallet] = useState<WalletRow | null>(null);

  useAutoCreditToast();

  if (error) {
    return (
      <div className="text-expense">
        {t('common.error')}: {error.message}
      </div>
    );
  }

  const wallets = (data?.wallets ?? []) as WalletRow[];
  const totals = walletsTotals(wallets);

  return (
    <div className="space-y-6">
      <PageHeader title={t('pageTitles.accounts')} subtitle={t('wallets.subtitle')} />

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
        <StatCard
          tone={totals.cash >= 0 ? 'income' : 'expense'}
          label={t('wallets.stats.cash')}
          value={formatCurrency(totals.cash)}
          icon={<Wallet className="size-4" />}
        />
        <StatCard
          tone="expense"
          label={t('wallets.stats.overdraftUsed')}
          value={formatCurrency(totals.overdraftUsed)}
          icon={<CreditCard className="size-4" />}
        />
        <StatCard
          tone={totals.available >= 0 ? 'income' : 'expense'}
          label={t('wallets.stats.available')}
          value={formatCurrency(totals.available)}
          icon={<Wallet className="size-4" />}
        />
      </div>

      {isLoading && (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {skeletonKeys(3).map((key) => (
            <SkeletonCard key={key} />
          ))}
        </div>
      )}

      {data && wallets.length === 0 && (
        <EmptyState
          icon={<Wallet className="size-12" />}
          title={t('wallets.noWallets')}
          description={t('wallets.noWalletsDesc')}
        />
      )}

      {wallets.length > 0 && (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {wallets.map((w) => {
            const od = walletOverdraft(w.cash, w.overdraftLimit);
            return (
              <Card key={w.id} surface="solid">
                <CardHeader className="flex flex-row items-center justify-between pb-2">
                  <CardTitle className="flex items-center gap-2 truncate text-sm font-medium">
                    <Wallet className="size-4 text-info" />
                    {w.name}
                    {w.isDefaultWallet && (
                      <Badge variant="secondary">{t('wallets.principal')}</Badge>
                    )}
                  </CardTitle>
                  <DropdownMenu>
                    <DropdownMenuTrigger
                      render={
                        <Button variant="ghost" size="icon-sm" aria-label={w.name}>
                          <MoreVertical className="size-4" />
                        </Button>
                      }
                    />
                    <DropdownMenuContent align="end">
                      <DropdownMenuItem onClick={() => setEditWallet(w)}>
                        <Pencil className="size-4" /> {t('common.edit')}
                      </DropdownMenuItem>
                      <DropdownMenuItem onClick={() => setAdjustWallet(w)}>
                        <SlidersHorizontal className="size-4" /> {t('wallets.adjust.title')}
                      </DropdownMenuItem>
                    </DropdownMenuContent>
                  </DropdownMenu>
                </CardHeader>
                <CardContent className="space-y-1">
                  <AmountDisplay amount={w.cash} size="lg" />
                  <Button variant="outline" className="min-h-11" onClick={() => setAdjustWallet(w)}>
                    <SlidersHorizontal className="size-4" />
                    {t('wallets.adjust.title')}
                  </Button>
                  {(w.cashQuality?.legacyMovementCount ?? 0) > 0 && (
                    <p className="text-xs text-muted-foreground">{t('cashForecast.legacyCash')}</p>
                  )}
                  {(w.cashQuality?.unresolvedMovementCount ?? 0) > 0 && (
                    <p className="text-xs text-expense">{t('cashForecast.unresolvedCash')}</p>
                  )}
                  {!!w.cashQuality?.assumedDelta && (
                    <p className="text-xs text-muted-foreground">{t('cashForecast.assumedCash')}</p>
                  )}
                  {w.cashQuality?.anchorBasis === 'recorded' && (
                    <p className="text-xs text-muted-foreground">
                      {t('cashForecast.legacyAnchor')}
                    </p>
                  )}
                  {w.overdraftLimit && (
                    <p className="text-xs text-muted-foreground">
                      {t('wallets.card.overdraftUsed')}: {formatCurrency(od.used)} ·{' '}
                      {t('wallets.card.available')}: {formatCurrency(od.available)}
                    </p>
                  )}
                </CardContent>
              </Card>
            );
          })}
        </div>
      )}

      <EditWalletDialog
        open={editWallet !== null}
        onOpenChange={(open) => {
          if (!open) setEditWallet(null);
        }}
        wallet={editWallet}
      />

      <AdjustBalanceDialog
        open={adjustWallet !== null}
        onOpenChange={(open) => {
          if (!open) setAdjustWallet(null);
        }}
        walletId={adjustWallet?.id ?? ''}
        currentCash={adjustWallet?.cash ?? 0}
      />
    </div>
  );
}
