import type { AppRouter } from '@fc/api';
import type { inferRouterOutputs } from '@trpc/server';
import { CreditCard, Landmark, Receipt, ReceiptText } from 'lucide-react';
import { cn } from '@/lib/utils';

type ItemKind = inferRouterOutputs<AppRouter>['dashboard']['upcomingItems'][number]['kind'];

type Props = {
  kind: ItemKind;
  className?: string;
};

export function KindIcon({ kind, className }: Props) {
  const cls = cn('shrink-0 text-muted-foreground', className ?? 'size-4');
  if (kind === 'card') return <CreditCard className={cls} />;
  if (kind === 'loan') return <Landmark className={cls} />;
  if (kind === 'one_time_charge') return <ReceiptText className={cls} />;
  return <Receipt className={cls} />;
}
