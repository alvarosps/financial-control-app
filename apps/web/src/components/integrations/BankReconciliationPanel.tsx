'use client';
import type { AppRouter } from '@fc/api';
import { Money } from '@fc/domain';
import type { inferRouterOutputs } from '@trpc/server';
import { useTranslations } from 'next-intl';
import { useState } from 'react';
import { AmountDisplay } from '@/components/shared/AmountDisplay';
import { ErrorAlert } from '@/components/shared/ErrorAlert';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { useOnlineStatus } from '@/hooks/useOnlineStatus';
import { trpc } from '@/lib/trpc/client';

type Detail = inferRouterOutputs<AppRouter>['integration']['bankDetail'];
export function BankReconciliationPanel({ externalAccountId }: { externalAccountId: string }) {
  const t = useTranslations('integration');
  const [cursor, setCursor] = useState<string>(),
    [movementId, setMovement] = useState<string>();
  const query = trpc.integration.bankMovements.useQuery({ externalAccountId, cursor });
  const balance = trpc.integration.balance.useQuery({ externalAccountId });
  const detail = trpc.integration.bankDetail.useQuery(
    { movementId: movementId ?? externalAccountId },
    { enabled: !!movementId, retry: false, refetchOnWindowFocus: false },
  );
  return (
    <section className="min-w-0 space-y-3" aria-label={t('bankTitle')}>
      <p className="text-sm text-muted-foreground">{t('bankHelp')}</p>
      {(query.error || balance.error || detail.error) && (
        <ErrorAlert
          message={t('error')}
          onRetry={() => {
            void query.refetch();
            if (movementId) void detail.refetch();
          }}
        />
      )}
      {balance.data && (
        <div className="rounded-md border p-3 text-sm">
          <p>{balance.data.comparable ? t('balanceCompared') : t('balanceUnknown')}</p>
          {balance.data.comparable && (
            <dl className="grid gap-2 sm:grid-cols-3">
              <div>
                <dt>{t('institutional')}</dt>
                <dd>
                  <AmountDisplay amount={Number(balance.data.institutional)} variant="neutral" />
                </dd>
              </div>
              <div>
                <dt>{t('calculated')}</dt>
                <dd>
                  <AmountDisplay amount={Number(balance.data.calculated)} variant="neutral" />
                </dd>
              </div>
              <div>
                <dt>{t('difference')}</dt>
                <dd>
                  <AmountDisplay amount={Number(balance.data.difference)} variant="neutral" />
                </dd>
              </div>
            </dl>
          )}
        </div>
      )}
      {query.isPending && <p role="status">{t('loading')}</p>}
      <ul className="space-y-2">
        {query.data?.items.map((item) => (
          <li key={item.id} className="space-y-1 rounded-lg border p-3">
            <p className="break-words text-sm">
              {item.description} · {item.date}
            </p>
            <p>
              <AmountDisplay
                amount={Number(item.amount)}
                currency={item.currency}
                variant="neutral"
              />{' '}
              · {t(`reviewStates.${item.state}`)}
            </p>
            <Button
              className="h-auto min-h-11 max-w-full whitespace-normal text-left"
              variant="outline"
              onClick={() => setMovement(item.id)}
            >
              {t('review', { description: item.description })}
            </Button>
          </li>
        ))}
      </ul>
      {query.data?.items.length === 0 && <p>{t('noMovements')}</p>}
      <div className="flex flex-wrap gap-2">
        {query.data?.nextCursor && (
          <Button
            variant="outline"
            onClick={() => {
              setMovement(undefined);
              setCursor(query.data?.nextCursor ?? undefined);
            }}
          >
            {t('next')}
          </Button>
        )}
        {cursor && (
          <Button
            variant="outline"
            onClick={() => {
              setMovement(undefined);
              setCursor(undefined);
            }}
          >
            {t('first')}
          </Button>
        )}
      </div>
      {movementId && detail.isPending && <p role="status">{t('loading')}</p>}
      {movementId && detail.data && (
        <BankReview
          key={`${detail.data.id}:${detail.data.version}:${detail.data.state}`}
          detail={detail.data}
          onClose={() => setMovement(undefined)}
        />
      )}
    </section>
  );
}
function BankReview({ detail, onClose }: { detail: Detail; onClose: () => void }) {
  const t = useTranslations('integration'),
    online = useOnlineStatus(),
    utils = trpc.useUtils();
  const [selected, setSelected] = useState<string[]>([]),
    [reason, setReason] = useState('');
  const completed = async () => {
    await utils.integration.invalidate();
    onClose();
  };
  const link = trpc.integration.linkBank.useMutation({ onSuccess: completed });
  const unlink = trpc.integration.unlinkBank.useMutation({ onSuccess: completed });
  const busy = link.isPending || unlink.isPending;
  const allocations = detail.candidates.filter((c) => selected.includes(c.transactionId));
  const sum = allocations.reduce(
    (total, c) => total.add(Money.fromString(c.amount, 'BRL')),
    Money.zero('BRL'),
  );
  const matches = detail.movement.currency === 'BRL' && sum.toDbString() === detail.movement.amount;
  return (
    <div className="min-w-0 space-y-3 rounded-lg border p-3">
      <h4 className="break-words font-heading text-base font-medium">
        {detail.movement.description}
      </h4>
      {(link.error || unlink.error) && (
        <ErrorAlert
          message={t('reviewError')}
          onRetry={() => void utils.integration.bankDetail.invalidate({ movementId: detail.id })}
        />
      )}
      {!online && <p role="status">{t('offline')}</p>}
      {detail.state === 'needs_review' && <p role="status">{t('changed')}</p>}
      {detail.links.length > 0 ? (
        <>
          <ul>
            {detail.links.map((row) => (
              <li className="break-words text-sm" key={row.id}>
                {row.description} · <AmountDisplay amount={Number(row.amount)} variant="neutral" />
              </li>
            ))}
          </ul>
          <label className="block space-y-1 text-sm" htmlFor={`unlink-${detail.id}`}>
            {t('unlinkReason')}
            <Input
              id={`unlink-${detail.id}`}
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              maxLength={500}
            />
          </label>
          <Button
            variant="outline"
            disabled={busy || !online || reason.trim().length < 3}
            onClick={() =>
              unlink.mutate({ movementId: detail.id, version: detail.version, reason })
            }
          >
            {t('unlink')}
          </Button>
        </>
      ) : (
        <>
          {!detail.reviewable && <p>{t('notReviewable')}</p>}
          {detail.candidatesTruncated && <p role="status">{t('candidateLimit')}</p>}
          <fieldset disabled={busy || !online} className="space-y-2">
            <legend className="text-sm font-medium">{t('selectPayments')}</legend>
            {detail.candidates.map((c) => (
              <label
                key={c.transactionId}
                className="flex min-h-11 items-center gap-3 rounded-md border p-2 text-sm"
              >
                <input
                  type="checkbox"
                  className="size-5 shrink-0"
                  checked={selected.includes(c.transactionId)}
                  onChange={(e) =>
                    setSelected((previous) =>
                      e.target.checked
                        ? [...previous, c.transactionId]
                        : previous.filter((id) => id !== c.transactionId),
                    )
                  }
                />
                <span className="min-w-0 break-words">
                  {c.description} · {c.date} ·{' '}
                  <AmountDisplay amount={Number(c.amount)} variant="neutral" />
                </span>
              </label>
            ))}
          </fieldset>
          {!detail.candidates.length && <p className="text-sm">{t('noCandidates')}</p>}
          <p className="text-sm">
            {t('allocated')} <AmountDisplay amount={sum.toNumber()} variant="neutral" /> /{' '}
            <AmountDisplay
              amount={Number(detail.movement.amount)}
              currency={detail.movement.currency}
              variant="neutral"
            />
          </p>
          <Button
            disabled={busy || !online || !detail.reviewable || !matches || !allocations.length}
            onClick={() =>
              link.mutate({
                movementId: detail.id,
                version: detail.version,
                allocations: allocations.map(({ transactionId, fingerprint }) => ({
                  transactionId,
                  fingerprint,
                })),
              })
            }
          >
            {t('confirm')}
          </Button>
        </>
      )}
      <Button className="ml-2" variant="ghost" disabled={busy} onClick={onClose}>
        {t('close')}
      </Button>
    </div>
  );
}
