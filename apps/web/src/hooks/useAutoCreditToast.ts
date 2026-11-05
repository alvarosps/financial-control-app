'use client';

import { useTranslations } from 'next-intl';
import { useEffect, useRef } from 'react';
import { toast } from 'sonner';
import { invalidateDashboard, trpc } from '@/lib/trpc/client';

// Module-level guard: the auto-credit toast fires at most once per tab session,
// even as the user navigates between the dashboard and the wallets screen.
let toastedThisSession = false;

/**
 * Runs income.autoCreditDue on mount (server-side idempotent auto-credit of due
 * income) and toasts the result once. staleTime + no focus-refetch stop the
 * materialize+settle scan from re-running every 30s / on every window refocus.
 */
export function useAutoCreditToast(): void {
  const t = useTranslations();
  const utils = trpc.useUtils();
  const { data } = trpc.income.autoCreditDue.useQuery(undefined, {
    staleTime: 5 * 60 * 1000,
    refetchOnWindowFocus: false,
  });
  const localRef = useRef(false);

  useEffect(() => {
    if (toastedThisSession || localRef.current) return;
    if (data && data.credited.length > 0) {
      toastedThisSession = true;
      localRef.current = true;
      toast.success(t('wallets.autoCredit.toast', { count: data.credited.length }));
      invalidateDashboard(utils);
      utils.account.walletsOverview.invalidate();
      utils.account.list.invalidate();
    }
  }, [data, t, utils]);
}
