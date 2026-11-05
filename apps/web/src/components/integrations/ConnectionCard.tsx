'use client';
import type { AppRouter } from '@fc/api';
import type { inferRouterOutputs } from '@trpc/server';
import { useLocale, useTranslations } from 'next-intl';
import { useState } from 'react';
import { ErrorAlert } from '@/components/shared/ErrorAlert';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { useOnlineStatus } from '@/hooks/useOnlineStatus';
import { trpc } from '@/lib/trpc/client';
import { toArray } from '@/lib/utils';
import { BankReconciliationPanel } from './BankReconciliationPanel';

type Connection = inferRouterOutputs<AppRouter>['integration']['list']['connections'][number];
export function IntegrationSettings() {
  const t = useTranslations('integration');
  const utils = trpc.useUtils(),
    online = useOnlineStatus();
  const query = trpc.integration.list.useQuery();
  const attach = trpc.integration.attach.useMutation({
    onSuccess: () => utils.integration.list.invalidate(),
  });
  return (
    <section className="min-w-0 space-y-4" aria-label={t('title')}>
      <h2 className="font-heading text-base font-medium">{t('title')}</h2>
      <p className="text-sm text-muted-foreground">{t('description')}</p>
      {(query.error || attach.error) && (
        <ErrorAlert message={t('error')} onRetry={() => void query.refetch()} />
      )}
      {query.isPending && <p role="status">{t('loading')}</p>}
      {query.data && !query.data.enabled && <p>{t('disabled')}</p>}
      {query.data?.enabled &&
        query.data.configuredItems.map((itemId, index) => (
          <Button
            key={itemId}
            variant="outline"
            disabled={!online || attach.isPending}
            onClick={() => attach.mutate({ itemId })}
          >
            {t('attach', { number: index + 1 })}
          </Button>
        ))}
      {query.data?.connections.map((connection) => (
        <ConnectionCard key={connection.id} connection={connection} enabled={query.data.enabled} />
      ))}
      {query.data?.connections.length === 0 && <p className="text-sm">{t('empty')}</p>}
    </section>
  );
}
export function ConnectionCard({
  connection,
  enabled,
}: {
  connection: Connection;
  enabled: boolean;
}) {
  const t = useTranslations('integration'),
    locale = useLocale();
  const utils = trpc.useUtils(),
    online = useOnlineStatus();
  const invalidate = async () => {
    await utils.integration.invalidate();
    await utils.purchaseInbox.coverage.invalidate();
    await utils.purchaseInbox.list.invalidate();
  };
  const pause = trpc.integration.pause.useMutation({ onSuccess: invalidate });
  const resume = trpc.integration.resume.useMutation({ onSuccess: invalidate });
  const sync = trpc.integration.sync.useMutation({ onSuccess: invalidate });
  const busy = pause.isPending || resume.isPending || sync.isPending;
  const time = (date: Date | null) => (date ? new Date(date).toLocaleString(locale) : t('unknown'));
  return (
    <Card surface="solid">
      <CardContent className="min-w-0 space-y-4">
        <div>
          <h3 className="font-heading text-base font-medium break-words">{connection.name}</h3>
          <p className="text-sm">{t(`statuses.${connection.status}`)}</p>
        </div>
        <dl className="grid gap-3 text-sm sm:grid-cols-2">
          <div>
            <dt className="text-muted-foreground">{t('sourceUpdated')}</dt>
            <dd>{time(connection.sourceUpdatedAt)}</dd>
          </div>
          <div>
            <dt className="text-muted-foreground">{t('fetched')}</dt>
            <dd>{time(connection.lastFetchedAt)}</dd>
          </div>
        </dl>
        {connection.errorCode && (
          <p role="status" className="text-sm">
            {t('sourceError')}
          </p>
        )}
        {(pause.error || resume.error || sync.error) && <ErrorAlert message={t('error')} />}
        <div className="flex flex-wrap gap-2">
          <Button
            disabled={!online || !enabled || busy || connection.status !== 'active'}
            onClick={() => sync.mutate({ connectionId: connection.id })}
          >
            {t('fetch')}
          </Button>
          {connection.status === 'active' ? (
            <Button
              variant="outline"
              disabled={!online || busy}
              onClick={() => pause.mutate({ connectionId: connection.id })}
            >
              {t('pause')}
            </Button>
          ) : (
            <Button
              variant="outline"
              disabled={!online || !enabled || busy}
              onClick={() => resume.mutate({ connectionId: connection.id })}
            >
              {t('resume')}
            </Button>
          )}
          {connection.status === 'auth_required' && (
            <a
              className="inline-flex min-h-11 items-center underline"
              href="https://meu.pluggy.ai"
              target="_blank"
              rel="noopener noreferrer"
            >
              {t('renew')}
            </a>
          )}
        </div>
        <p className="text-xs text-muted-foreground">{t('pauseHelp')}</p>
        {connection.jobs.some((job) => job.status === 'failed' || job.errorCode) && (
          <p role="status" className="text-sm">
            {t('jobFailure')}
          </p>
        )}
        {connection.jobs.some((job) => job.status === 'pending' || job.status === 'running') && (
          <p role="status" className="text-sm">
            {t('processing')}
          </p>
        )}
        <ul className="space-y-4">
          {connection.accounts.map((account) => (
            <AccountMapping key={account.id} account={account} />
          ))}
        </ul>
      </CardContent>
    </Card>
  );
}
function AccountMapping({ account }: { account: Connection['accounts'][number] }) {
  const t = useTranslations('integration'),
    utils = trpc.useUtils(),
    online = useOnlineStatus();
  const [selected, setSelected] = useState(''),
    [reviewing, setReviewing] = useState(false);
  const accounts = trpc.account.list.useQuery();
  const map = trpc.integration.mapAccount.useMutation({
    onSuccess: async () => {
      await utils.integration.list.invalidate();
      await utils.purchaseInbox.invalidate();
    },
  });
  const options = toArray(accounts.data).filter(
    (a) =>
      a.isActive &&
      a.currency === account.currency &&
      a.type === (account.kind === 'CREDIT' ? 'credit_card' : 'checking'),
  );
  const mapped = toArray(accounts.data).find((a) => a.id === account.accountId);
  return (
    <li className="min-w-0 space-y-3 rounded-lg border p-3">
      <h4 className="break-words font-medium">{account.name}</h4>
      {map.error && <ErrorAlert message={t('error')} />}
      {account.accountId ? (
        <p className="text-sm">{t('mapped', { name: mapped?.name ?? t('unknown') })}</p>
      ) : (
        <div className="flex flex-wrap items-end gap-2">
          <label className="min-w-0 flex-1 space-y-1 text-sm">
            {t('mapAccount')}
            <select
              className="block min-h-11 w-full rounded-md border bg-background px-3"
              value={selected}
              onChange={(e) => setSelected(e.target.value)}
            >
              <option value="">{t('chooseAccount')}</option>
              {options.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.name}
                </option>
              ))}
            </select>
          </label>
          <Button
            disabled={!selected || map.isPending || !online}
            onClick={() => map.mutate({ externalAccountId: account.id, accountId: selected })}
          >
            {t('map')}
          </Button>
        </div>
      )}
      {account.kind === 'BANK' && (
        <Button variant="outline" onClick={() => setReviewing(!reviewing)}>
          {reviewing ? t('hideReview') : t('reviewBank')}
        </Button>
      )}
      {reviewing && <BankReconciliationPanel externalAccountId={account.id} />}
      {account.kind === 'CREDIT' && (
        <a className="inline-flex min-h-11 items-center text-sm underline" href="/purchases">
          {t('reviewPurchases')}
        </a>
      )}
      {account.unresolvedCardEvidence > 0 && (
        <CardExceptions externalAccountId={account.id} count={account.unresolvedCardEvidence} />
      )}
    </li>
  );
}
function CardExceptions({
  externalAccountId,
  count,
}: {
  externalAccountId: string;
  count: number;
}) {
  const t = useTranslations('integration');
  const [cursor, setCursor] = useState<string>();
  const query = trpc.integration.cardExceptions.useQuery({ externalAccountId, cursor });
  return (
    <div className="space-y-2 text-sm">
      <p role="status">{t('cardExceptions', { count })}</p>
      {query.error && <ErrorAlert message={t('error')} onRetry={() => void query.refetch()} />}
      <ul>
        {query.data?.items.map((item) => (
          <li className="break-words" key={item.id}>
            {item.description} · {item.date} · {t('reviewSource')}
          </li>
        ))}
      </ul>
      {query.data?.nextCursor && (
        <Button variant="outline" onClick={() => setCursor(query.data?.nextCursor ?? undefined)}>
          {t('next')}
        </Button>
      )}
      {cursor && (
        <Button variant="outline" onClick={() => setCursor(undefined)}>
          {t('first')}
        </Button>
      )}
    </div>
  );
}
