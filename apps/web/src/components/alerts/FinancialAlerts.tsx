'use client';
import { Money } from '@fc/domain';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { useState } from 'react';
import { AmountDisplay } from '@/components/shared/AmountDisplay';
import { Button } from '@/components/ui/button';
import { buttonVariants } from '@/components/ui/button-variants';
import { Card } from '@/components/ui/card';
import { useOnlineStatus } from '@/hooks/useOnlineStatus';
import { trpc } from '@/lib/trpc/client';

export function FinancialAlerts({
  month,
  year,
  showHistory = false,
}: {
  month?: number;
  year?: number;
  showHistory?: boolean;
}) {
  const t = useTranslations('financialAlerts'),
    online = useOnlineStatus(),
    utils = trpc.useUtils();
  const [open, setOpen] = useState(false),
    [all, setAll] = useState(showHistory),
    [failed, setFailed] = useState(false);
  const input = month && year ? { month, year } : undefined;
  const query = trpc.financialAlert.list.useQuery(input, { enabled: open, retry: false });
  const refresh = trpc.financialAlert.refresh.useMutation(),
    decision = trpc.financialAlert.setState.useMutation();
  const busy = refresh.isPending || decision.isPending;
  const update = async () => {
    setFailed(false);
    try {
      const result = await refresh.mutateAsync(input);
      utils.financialAlert.list.setData(input, result);
    } catch {
      setFailed(true);
    }
  };
  const act = async (
    id: string,
    revision: number,
    state: 'open' | 'read' | 'muted' | 'resolved',
  ) => {
    setFailed(false);
    try {
      await decision.mutateAsync({ id, revision, state });
      await utils.financialAlert.invalidate();
    } catch {
      setFailed(true);
    }
  };
  const rows =
    query.data?.items.filter((row) => all || row.state === 'open' || row.state === 'read') ?? [];
  return (
    <section className="space-y-3">
      <Button
        variant="outline"
        aria-expanded={open}
        onClick={() => {
          setOpen(!open);
          if (!open && online) void update();
        }}
      >
        {t('title')}
      </Button>
      {open && (
        <Card surface="solid" className="space-y-4 p-4">
          <p className="text-sm text-muted-foreground">{t('intro')}</p>
          <div className="flex flex-wrap items-center gap-3">
            <Button variant="outline" disabled={busy || !online} onClick={() => void update()}>
              {t('refresh')}
            </Button>
            <label className="flex items-center gap-2 text-sm">
              <input type="checkbox" checked={all} onChange={(e) => setAll(e.target.checked)} />
              {t('history')}
            </label>
          </div>
          {(failed || query.isError) && <p role="alert">{t('error')}</p>}
          {!online && <p role="status">{t('offline')}</p>}
          {busy && <p role="status">{t('updating')}</p>}
          {query.data?.truncated && <p>{t('truncated')}</p>}
          {rows.length === 0 && !query.isLoading && !busy && <p>{t('empty')}</p>}
          <ul className="space-y-4">
            {rows.map((row) => {
              const recurring =
                row.rule === 'recurring_price' || row.rule === 'recurring_candidate';
              const budget = row.rule === 'budget_near' || row.rule === 'budget_exceeded';
              const href = budget
                ? '/budgets'
                : row.rule === 'cash_coverage'
                  ? '/accounts'
                  : row.rule === 'projected_commitment'
                    ? '/projection'
                    : '/purchases';
              return (
                <li key={row.id} className="space-y-2 rounded-lg border p-3">
                  <div className="flex flex-wrap justify-between gap-2">
                    <h3 className="font-heading text-base font-medium">{t(`rules.${row.rule}`)}</h3>
                    <span className="text-sm">{t(`states.${row.state}`)}</span>
                  </div>
                  {!['cash_coverage', 'projected_commitment'].includes(row.rule) && !budget && (
                    <p>{row.evidence.label}</p>
                  )}
                  {budget && (
                    <p>
                      {t(
                        `scopes.${row.evidence.label as 'all' | 'own' | 'family' | 'work' | 'property'}`,
                      )}
                    </p>
                  )}
                  {row.evidence.amount && (
                    <AmountDisplay
                      amount={Money.fromString(row.evidence.amount, 'BRL').toNumber()}
                      variant="neutral"
                    />
                  )}
                  {row.evidence.limit && (
                    <p>
                      {t('limit')}{' '}
                      <AmountDisplay
                        amount={Money.fromString(row.evidence.limit, 'BRL').toNumber()}
                        variant="neutral"
                      />
                    </p>
                  )}
                  {recurring && (
                    <div className="space-y-1 text-sm">
                      <p>{t('recurringReason', { count: row.evidence.count ?? 0 })}</p>
                      <p>{t('dates', { dates: (row.evidence.sampleDates ?? []).join(', ') })}</p>
                      <p>
                        {t('previous')}{' '}
                        <AmountDisplay
                          amount={Money.fromString(
                            row.evidence.previousAmount ?? '0',
                            'BRL',
                          ).toNumber()}
                          variant="neutral"
                        />{' '}
                        · {t('tolerance')}{' '}
                        <AmountDisplay
                          amount={Money.fromString(
                            row.evidence.toleranceAmount ?? '0',
                            'BRL',
                          ).toNumber()}
                          variant="neutral"
                        />
                      </p>
                      <p>{t('recurringReview')}</p>
                    </div>
                  )}
                  {row.rule === 'cash_coverage' && (
                    <div className="text-sm">
                      <p>{t('coverageReason')}</p>
                      <ul>
                        {(row.evidence.reason ?? '')
                          .split(',')
                          .filter(Boolean)
                          .map((reason) => (
                            <li key={reason}>
                              {t(
                                `reasons.${reason as 'no_wallet' | 'unsupported_currency' | 'unreviewed_anchor' | 'stale_anchor' | 'unresolved_movements' | 'expense_coverage' | 'income_coverage' | 'bounded_scan'}`,
                              )}
                            </li>
                          ))}
                      </ul>
                    </div>
                  )}
                  {row.rule === 'projected_commitment' && (
                    <p className="text-sm">{t('projectionReason')}</p>
                  )}
                  {row.evidence.basis === 'estimated_cycle' && (
                    <p className="text-sm">{t('estimatedCycle')}</p>
                  )}
                  <div className="flex flex-wrap gap-2">
                    <Link
                      href={href}
                      className={buttonVariants({ variant: 'outline', size: 'default' })}
                    >
                      {t('review')}
                    </Link>
                    {row.state === 'open' && (
                      <Button
                        variant="outline"
                        disabled={busy || !online || !row.active}
                        onClick={() => void act(row.id, row.revision, 'read')}
                      >
                        {t('read')}
                      </Button>
                    )}
                    {row.state !== 'muted' ? (
                      <Button
                        variant="outline"
                        disabled={busy || !online || !row.active}
                        onClick={() => void act(row.id, row.revision, 'muted')}
                      >
                        {t('mute')}
                      </Button>
                    ) : (
                      <Button
                        variant="outline"
                        disabled={busy || !online || !row.active}
                        onClick={() => void act(row.id, row.revision, 'open')}
                      >
                        {t('unmute')}
                      </Button>
                    )}
                    {row.state !== 'resolved' && (
                      <Button
                        variant="outline"
                        disabled={busy || !online || !row.active}
                        onClick={() => void act(row.id, row.revision, 'resolved')}
                      >
                        {t('resolve')}
                      </Button>
                    )}
                  </div>
                </li>
              );
            })}
          </ul>
          <p className="text-sm text-muted-foreground">{t('actionsNote')}</p>
        </Card>
      )}
    </section>
  );
}
