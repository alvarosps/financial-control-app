'use client';
import { Money } from '@fc/domain';
import { useTranslations } from 'next-intl';
import { useState } from 'react';
import { ErrorAlert } from '@/components/shared/ErrorAlert';
import { MoneyField } from '@/components/shared/MoneyField';
import { SkeletonCard } from '@/components/shared/SkeletonCard';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { formatCurrencyValue } from '@/lib/format';
import { trpc } from '@/lib/trpc/client';

type EvidenceDraft = { amount: string; source: string; closingDate: string; dueDate: string };
const emptyDraft: EvidenceDraft = { amount: '', source: '', closingDate: '', dueDate: '' };
function amountValue(value: string) {
  const normalized = value.trim().includes(',')
    ? value.trim().replaceAll('.', '').replace(',', '.')
    : value.trim();
  return /^-?\d{1,10}(\.\d{1,2})?$/.test(normalized)
    ? Money.fromString(normalized, 'BRL').toDbString()
    : null;
}
export function MonthClosingChecklist({
  month,
  year,
  onClosed,
}: {
  month: number;
  year: number;
  onClosed: () => void;
}) {
  const t = useTranslations();
  const [drafts, setDrafts] = useState<Record<string, EvidenceDraft>>({});
  const [waivers, setWaivers] = useState<Record<string, string>>({});
  const [notes, setNotes] = useState('');
  const wallets = Object.entries(drafts).flatMap(([key, d]) =>
    key.startsWith('wallet:') && amountValue(d.amount) !== null && d.source.trim().length >= 3
      ? [
          {
            accountId: key.slice(7),
            amount: amountValue(d.amount) ?? '0.00',
            source: d.source.trim(),
          },
        ]
      : [],
  );
  const cards = Object.entries(drafts).flatMap(([key, d]) =>
    key.startsWith('card:') &&
    amountValue(d.amount) !== null &&
    d.source.trim().length >= 3 &&
    /^\d{4}-\d{2}-\d{2}$/.test(d.closingDate) &&
    /^\d{4}-\d{2}-\d{2}$/.test(d.dueDate)
      ? [
          {
            accountId: key.slice(5),
            totalAmount: amountValue(d.amount) ?? '0.00',
            source: d.source.trim(),
            closingDate: d.closingDate,
            dueDate: d.dueDate,
          },
        ]
      : [],
  );
  const preview = trpc.dashboard.closingPreview.useQuery(
    { month, year, review: { wallets, cards } },
    { retry: false },
  );
  const utils = trpc.useUtils();
  const close = trpc.dashboard.closeMonth.useMutation({
    onSuccess: () => {
      void utils.dashboard.monthStatus.invalidate({ month, year });
      void utils.dashboard.monthlySummary.invalidate({ month, year });
      void utils.dashboard.closingPreview.invalidate({ month, year });
      onClosed();
    },
  });
  const data = preview.data;
  const blocked =
    !data ||
    preview.isFetching ||
    !!preview.error ||
    close.isPending ||
    data.items.some(
      (item) =>
        item.severity === 'critical' ||
        (item.severity === 'warning' && (waivers[item.key]?.trim().length ?? 0) < 3),
    );
  const update = (key: string, fields: Partial<EvidenceDraft>) =>
    setDrafts((old) => ({ ...old, [key]: { ...emptyDraft, ...old[key], ...fields } }));
  if (!data && preview.isLoading) return <SkeletonCard />;
  return (
    <div className="space-y-4">
      <p className="text-sm text-muted-foreground">{t('closingChecklist.hint')}</p>
      {preview.error && (
        <ErrorAlert message={preview.error.message} onRetry={() => void preview.refetch()} />
      )}
      {close.error && <ErrorAlert message={close.error.message} />}
      {data && (
        <>
          <p className="text-sm font-numeric tabular-nums">
            {t('closingChecklist.totals', {
              income: formatCurrencyValue(Money.fromString(data.totals.income, 'BRL').toNumber()),
              expenses: formatCurrencyValue(
                Money.fromString(data.totals.expenses, 'BRL').toNumber(),
              ),
            })}
          </p>
          <ul className="space-y-4" aria-live="polite">
            {data.items.map((item) => {
              const draft = drafts[item.key] ?? emptyDraft;
              const proofField = item.key.startsWith('wallet:') || item.key.startsWith('card:');
              return (
                <li key={item.key} className="rounded-md border p-3 space-y-2">
                  <p className="font-medium text-sm">
                    {item.name ? `${item.name} — ` : ''}
                    {t(`closingChecklist.codes.${item.code}`)}
                  </p>
                  <p className="text-xs text-muted-foreground">
                    {t(`closingChecklist.status.${item.severity}`)}
                    {item.count !== undefined ? ` (${item.count})` : ''}
                  </p>
                  {item.expected !== undefined && (
                    <p className="text-sm font-numeric tabular-nums">
                      {t('closingChecklist.recorded', {
                        amount: formatCurrencyValue(
                          Money.fromString(item.expected, 'BRL').toNumber(),
                        ),
                      })}
                    </p>
                  )}
                  {proofField && (
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                      <MoneyField
                        id={`close-${item.key}-amount`}
                        label={t('closingChecklist.bankAmount')}
                        value={draft.amount}
                        onChange={(amount) => update(item.key, { amount })}
                      />
                      <div>
                        <Label htmlFor={`close-${item.key}-source`}>
                          {t('closingChecklist.source')}
                        </Label>
                        <Input
                          id={`close-${item.key}-source`}
                          maxLength={200}
                          value={draft.source}
                          onChange={(e) => update(item.key, { source: e.target.value })}
                        />
                      </div>
                      {item.kind === 'card' && (
                        <>
                          <div>
                            <Label htmlFor={`close-${item.key}-closing`}>
                              {t('closingChecklist.closingDate')}
                            </Label>
                            <Input
                              type="date"
                              id={`close-${item.key}-closing`}
                              value={draft.closingDate}
                              onChange={(e) => update(item.key, { closingDate: e.target.value })}
                            />
                          </div>
                          <div>
                            <Label htmlFor={`close-${item.key}-due`}>
                              {t('closingChecklist.dueDate')}
                            </Label>
                            <Input
                              type="date"
                              id={`close-${item.key}-due`}
                              min={draft.closingDate}
                              value={draft.dueDate}
                              onChange={(e) => update(item.key, { dueDate: e.target.value })}
                            />
                          </div>
                        </>
                      )}
                    </div>
                  )}
                  {item.severity === 'warning' && (
                    <div>
                      <Label htmlFor={`close-waiver-${item.key}`}>
                        {t('closingChecklist.justification')}
                      </Label>
                      <Input
                        id={`close-waiver-${item.key}`}
                        maxLength={500}
                        value={waivers[item.key] ?? ''}
                        onChange={(e) => setWaivers({ ...waivers, [item.key]: e.target.value })}
                      />
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        </>
      )}
      <div>
        <Label htmlFor="closing-notes">{t('closingChecklist.notes')}</Label>
        <Input
          id="closing-notes"
          maxLength={500}
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
        />
      </div>
      <div className="flex flex-wrap gap-2">
        <Button
          variant="outline"
          disabled={preview.isFetching || close.isPending}
          onClick={() => void preview.refetch()}
        >
          {t('closingChecklist.refresh')}
        </Button>
        <Button
          disabled={blocked}
          onClick={() => {
            if (data)
              close.mutate({
                month,
                year,
                notes: notes.trim(),
                review: {
                  wallets,
                  cards,
                  waivers: Object.fromEntries(
                    Object.entries(waivers).filter(([, v]) => v.trim().length >= 3),
                  ),
                  reviewHash: data.reviewHash,
                },
              });
          }}
        >
          {close.isPending ? t('monthClosing.closing') : t('monthClosing.confirmClose')}
        </Button>
      </div>
    </div>
  );
}
