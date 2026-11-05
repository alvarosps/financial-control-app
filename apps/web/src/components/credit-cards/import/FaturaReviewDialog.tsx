'use client';

import { canManuallyLinkFaturaItem, type ReviewReason } from '@fc/domain';
import { Loader2, TriangleAlert } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { type ReactNode, useMemo, useState } from 'react';
import { toast } from 'sonner';
import { ErrorAlert } from '@/components/shared/ErrorAlert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { formatCurrency } from '@/lib/format';
import { invalidateCreditCardContext } from '@/lib/invalidate';
import { trpc } from '@/lib/trpc/client';
import { resolveTRPCError } from '@/lib/trpc-errors';

const NS = 'components-credit-cards-import-faturareviewdialog';
const DIALOG_CLASS_NAME =
  'h-[calc(100dvh-1rem)] max-h-[calc(100dvh-1rem)] w-[calc(100vw-1rem)] max-w-[calc(100vw-1rem)] overflow-y-auto sm:h-[calc(100dvh-2rem)] sm:max-h-[calc(100dvh-2rem)] sm:w-[calc(100vw-2rem)] sm:max-w-[calc(100vw-2rem)] 2xl:max-w-[112rem]';

type Props = {
  importId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  defaultSourceAccountId: string;
  onComplete?: (completion: 'applied' | 'discarded') => void;
  headerContent?: ReactNode;
};

type ReviewChoice = 'accept' | 'keep' | undefined;
type ReversalChoice = 'apply' | 'keep' | undefined;
type MissingChoice = 'keep' | 'remove' | { kind: 'link'; suggestionIndex: number } | undefined;
type NewKind = 'skip' | 'add_expense' | 'add_installment' | 'add_fixed_charge' | 'add_refund';
type NewItemState = {
  kind: NewKind;
  description: string;
  current: number | null;
  total: number | null;
  targetCardAccountId: string | null;
};

const newKinds = [
  'skip',
  'add_expense',
  'add_installment',
  'add_fixed_charge',
  'add_refund',
] as const;

function isNewKind(value: string | null): value is NewKind {
  return newKinds.some((kind) => kind === value);
}

function cents(value: string): number {
  const negative = value.startsWith('-');
  const [whole = '0', fraction = '00'] = (negative ? value.slice(1) : value).split('.');
  const result = Number(whole) * 100 + Number(fraction.padEnd(2, '0').slice(0, 2));
  return negative ? -result : result;
}

function hasPositiveAmount(value: string): boolean {
  return cents(value) > 0;
}

function firstName(holder: string | null): string {
  return holder?.trim().split(/\s+/)[0] ?? '';
}

function money(value: string): string {
  return formatCurrency(Number(value));
}

function newItemKey(item: {
  amountBRL: string;
  cardLastFour: string | null;
  description: string;
  installmentCurrent: number | null;
  installmentTotal: number | null;
  purchaseDate: string | null;
}): string {
  return [
    item.cardLastFour ?? '',
    item.description,
    item.amountBRL,
    item.purchaseDate ?? '',
    item.installmentCurrent ?? '',
    item.installmentTotal ?? '',
  ].join('|');
}

export function FaturaReviewDialog(props: Props) {
  return <FaturaReviewContent key={props.importId} {...props} />;
}

function FaturaReviewContent({
  importId,
  open,
  onOpenChange,
  defaultSourceAccountId,
  onComplete,
  headerContent,
}: Props) {
  const t = useTranslations();
  const utils = trpc.useUtils();
  const draft = trpc.faturaImport.get.useQuery({ importId }, { enabled: open });
  const [reviewChoices, setReviewChoices] = useState<Record<number, ReviewChoice>>({});
  const [priceScopes, setPriceScopes] = useState<Record<number, 'cycle' | 'from_cycle'>>({});
  const [reviewedImportId, setReviewedImportId] = useState<string | null>(null);
  const [reversalChoices, setReversalChoices] = useState<Record<number, ReversalChoice>>({});
  const [missingChoices, setMissingChoices] = useState<Record<string, MissingChoice>>({});
  const [newItems, setNewItems] = useState<Record<number, NewItemState>>({});
  const [acknowledgeTotalMismatch, setAcknowledgeTotalMismatch] = useState(false);
  const data = draft.data;
  const suggestions = data?.itemsJson.suggestions ?? [];
  const cardAccounts = data?.itemsJson.cardAccounts ?? [];
  const match = data?.itemsJson.matchResult;
  const reversalBundles = data?.itemsJson.reversalBundles ?? [];
  const blockedGroups = data?.itemsJson.blockedGroups ?? [];

  const defaults = useMemo(() => {
    const next: Record<number, NewItemState> = {};
    suggestions.forEach((suggestion, index) => {
      const additional = suggestion.parsed.isAdditional
        ? ` (${firstName(suggestion.parsed.holderName)})`
        : '';
      next[index] = {
        kind: hasPositiveAmount(suggestion.parsed.amountBRL) ? suggestion.suggestedKind : 'skip',
        description: `${suggestion.parsed.description}${additional}`,
        current: suggestion.parsed.installmentCurrent,
        total: suggestion.parsed.installmentTotal,
        targetCardAccountId: suggestion.targetCardAccountId,
      };
    });
    return next;
  }, [suggestions]);

  const newItem = (index: number): NewItemState =>
    newItems[index] ??
    defaults[index] ?? {
      kind: 'skip',
      description: '',
      current: null,
      total: null,
      targetCardAccountId: null,
    };

  const newItemKeys = useMemo(() => {
    const occurrences = new Map<string, number>();
    return suggestions.map((suggestion) => {
      const base = newItemKey(suggestion.parsed);
      const count = occurrences.get(base) ?? 0;
      occurrences.set(base, count + 1);
      return `${base}|${count}`;
    });
  }, [suggestions]);
  const linkedSuggestionIndexes = useMemo(
    () =>
      new Set(
        Object.values(missingChoices).flatMap((choice) =>
          typeof choice === 'object' ? [choice.suggestionIndex] : [],
        ),
      ),
    [missingChoices],
  );

  const apply = trpc.faturaImport.applyDraft.useMutation({
    onSuccess: async (result) => {
      await Promise.all([
        invalidateCreditCardContext(utils),
        utils.faturaImport.get.invalidate(),
        utils.faturaImport.listByCard.invalidate(),
      ]);
      toast.success(
        result.reconciliation?.status === 'difference'
          ? t('statement.appliedWithDifference')
          : t(`${NS}.applied`),
      );
      onComplete?.('applied');
      onOpenChange(false);
    },
    onError: (error) => toast.error(resolveTRPCError(error, t)),
  });
  const discard = trpc.faturaImport.discard.useMutation({
    onSuccess: async () => {
      await utils.faturaImport.listByCard.invalidate();
      onComplete?.('discarded');
      onOpenChange(false);
    },
  });

  const pendingReview = (match?.review ?? []).some(
    (_, index) => reviewChoices[index] === undefined,
  );
  const pendingReversal = reversalBundles.some((_, index) => reversalChoices[index] === undefined);
  const pendingMissing = (match?.missingInSystem ?? []).some(
    (item) => missingChoices[item.transactionId] === undefined,
  );
  const pendingTarget = suggestions.some((_, index) => {
    if (linkedSuggestionIndexes.has(index)) return false;
    const state = newItem(index);
    return state.kind !== 'skip' && state.targetCardAccountId === null;
  });
  const acceptedCents = useMemo(() => {
    let total = 0;
    match?.matched.forEach((pair) => {
      total += cents(pair.parsed.amountBRL) * (pair.parsed.isRefund ? -1 : 1);
    });
    match?.review.forEach((pair, index) => {
      if (reviewChoices[index] === 'accept') {
        total += cents(pair.parsed.amountBRL) * (pair.parsed.isRefund ? -1 : 1);
      } else {
        total +=
          cents(pair.expected.amountBRL) *
          (pair.expected.domainType === 'credit_card_refund' ? -1 : 1);
      }
    });
    suggestions.forEach((suggestion, index) => {
      const state = newItems[index] ??
        defaults[index] ?? {
          kind: 'skip' as const,
          description: '',
          current: null,
          total: null,
        };
      if (
        (linkedSuggestionIndexes.has(index) || state.kind !== 'skip') &&
        hasPositiveAmount(suggestion.parsed.amountBRL)
      ) {
        total += cents(suggestion.parsed.amountBRL) * (suggestion.parsed.isRefund ? -1 : 1);
      }
    });
    reversalBundles.forEach((bundle, index) => {
      if (reversalChoices[index] === 'apply') {
        total -= cents(bundle.netRefundBRL);
      } else if (bundle.expected !== null) {
        total +=
          cents(bundle.expected.amountBRL) *
          (bundle.expected.domainType === 'credit_card_refund' ? -1 : 1);
      }
    });
    match?.missingInSystem.forEach((item) => {
      if (missingChoices[item.transactionId] === 'keep') {
        total += cents(item.amountBRL) * (item.domainType === 'credit_card_refund' ? -1 : 1);
      }
    });
    return total;
  }, [
    defaults,
    linkedSuggestionIndexes,
    match,
    missingChoices,
    newItems,
    reversalBundles,
    reversalChoices,
    reviewChoices,
    suggestions,
  ]);

  function decisions(): Parameters<typeof apply.mutate>[0]['decisions'] {
    const result: Parameters<typeof apply.mutate>[0]['decisions'] = [];
    match?.review.forEach((pair, index) => {
      const choice = reviewChoices[index];
      if (choice !== 'accept') {
        result.push({ kind: 'skip' });
        return;
      }
      const expected = pair.expected;
      if (expected.domainType === 'credit_card_installment' && expected.scheduleId !== null) {
        result.push({
          kind: 'edit_installment',
          scheduleId: expected.scheduleId,
          description: expected.description,
          amount: pair.parsed.amountBRL,
          totalInstallments: pair.parsed.installmentTotal ?? expected.totalInstallments ?? 1,
          currentInstallmentNumber:
            pair.parsed.installmentCurrent ?? expected.installmentNumber ?? 1,
        });
      } else if (expected.domainType !== 'credit_card_expense' && expected.scheduleId !== null) {
        result.push({
          kind: 'update_schedule_amount',
          scheduleId: expected.scheduleId,
          amount: pair.parsed.amountBRL,
          scope: priceScopes[index] ?? 'cycle',
        });
      } else {
        result.push({
          kind: 'update_expense',
          transactionId: expected.transactionId,
          amount: pair.parsed.amountBRL,
        });
      }
    });
    suggestions.forEach((suggestion, index) => {
      if (linkedSuggestionIndexes.has(index)) return;
      const state = newItem(index);
      if (state.kind === 'skip' || !hasPositiveAmount(suggestion.parsed.amountBRL)) {
        result.push({ kind: 'skip' });
      } else if (state.targetCardAccountId === null) {
        return;
      } else if (state.kind === 'add_installment') {
        result.push({
          kind: 'add_installment',
          suggestionIndex: index,
          targetCardAccountId: state.targetCardAccountId,
          description: state.description,
          amount: suggestion.parsed.amountBRL,
          totalInstallments: state.total ?? 2,
          currentInstallmentNumber: state.current ?? 1,
        });
      } else {
        result.push({
          kind: state.kind,
          suggestionIndex: index,
          targetCardAccountId: state.targetCardAccountId,
          description: state.description,
          amount: suggestion.parsed.amountBRL,
        });
      }
    });
    reversalBundles.forEach((_, index) => {
      const action = reversalChoices[index];
      if (action !== undefined) {
        result.push({ kind: 'resolve_reversal_bundle', bundleIndex: index, action });
      }
    });
    match?.missingInSystem.forEach((item) => {
      const choice = missingChoices[item.transactionId];
      if (typeof choice === 'object') {
        result.push({
          kind: 'link_statement_item',
          suggestionIndex: choice.suggestionIndex,
          transactionId: item.transactionId,
        });
      } else if (choice !== undefined) {
        result.push({
          kind: 'resolve_missing_item',
          transactionId: item.transactionId,
          action: choice,
        });
      }
    });
    return result;
  }

  if (data === undefined || match === undefined) {
    return (
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent className={DIALOG_CLASS_NAME}>
          <DialogHeader>
            <DialogTitle>{t(`${NS}.title`)}</DialogTitle>
          </DialogHeader>
          {draft.error !== null ? (
            <ErrorAlert message={draft.error.message} onRetry={() => void draft.refetch()} />
          ) : data !== undefined ? (
            <ErrorAlert message={t(`${NS}.loadFailed`)} onRetry={() => void draft.refetch()} />
          ) : (
            <div
              className="flex items-center justify-center gap-2 py-10 text-sm text-muted-foreground"
              role="status"
            >
              <Loader2 className="size-4 animate-spin" />
              {t('common.loading')}
            </div>
          )}
        </DialogContent>
      </Dialog>
    );
  }
  const totals = data.itemsJson.totals;
  if (data.status === 'applied') {
    return (
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t('statement.alreadyApplied')}</DialogTitle>
          </DialogHeader>
          <p>
            {t(`statement.reconciliation.${data.itemsJson.reconciliation?.status ?? 'unknown'}`)}
          </p>
          <Button onClick={() => onOpenChange(false)}>{t('common.close')}</Button>
        </DialogContent>
      </Dialog>
    );
  }
  const deltaWarn = totals.delta !== null && Math.abs(cents(totals.delta)) > 5;
  const acceptedDeltaWarn =
    data.statedTotal !== null && Math.abs(acceptedCents - cents(data.statedTotal)) > 5;
  const changeCount = decisions().filter(
    (decision) =>
      decision.kind !== 'skip' &&
      (decision.kind !== 'resolve_reversal_bundle' || decision.action === 'apply') &&
      (decision.kind !== 'resolve_missing_item' || decision.action === 'remove'),
  ).length;
  const reasonKeys: Record<ReviewReason, string> = {
    nome_aproximado: 'reasonNomeAproximado',
    valor_aproximado: 'reasonValorAproximado',
    valor_divergente: 'reasonValorDivergente',
    parcela_numero: 'reasonParcelaNumero',
    parcela_total: 'reasonParcelaTotal',
    parcela_ausente_na_fatura: 'reasonParcelaAusenteNaFatura',
    assinatura_preco: 'reasonAssinaturaPreco',
  };
  const actionKeys: Record<NewKind, string> = {
    skip: 'actionSkip',
    add_expense: 'actionAddExpense',
    add_installment: 'actionAddInstallment',
    add_fixed_charge: 'actionAddFixedCharge',
    add_refund: 'actionAddRefund',
  };
  const missingTypeKeys: Record<string, string> = {
    credit_card_expense: 'typeExpense',
    credit_card_fixed_charge: 'typeFixedCharge',
    credit_card_installment: 'typeInstallment',
    credit_card_refund: 'typeRefund',
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className={DIALOG_CLASS_NAME}>
        <DialogHeader>
          <DialogTitle>{t(`${NS}.title`)}</DialogTitle>
          <p className="text-xs text-muted-foreground">
            {t(`${NS}.profile`, { profile: data.profileId, model: data.modelUsed })}
            {' · '}
            {t(`${NS}.dueDate`, { date: data.dueDate })}
          </p>
          {headerContent}
        </DialogHeader>

        <div className="space-y-2 rounded-md border p-3 text-sm">
          <p>{t('statement.competence', { period: `${data.billingMonth}/${data.billingYear}` })}</p>
          {(data.periodConfidence !== 'confirmed' ||
            `${data.billingYear}-${String(data.billingMonth).padStart(2, '0')}` >
              new Date().toISOString().slice(0, 7)) && (
            <p className="text-muted-foreground">{t('statement.estimatedImport')}</p>
          )}
          <Label className="flex items-center gap-2">
            <input
              type="checkbox"
              className="size-4 shrink-0"
              checked={reviewedImportId === importId}
              onChange={(event) => setReviewedImportId(event.target.checked ? importId : null)}
            />
            {t('statement.confirmPeriod')}
          </Label>
        </div>

        <div className="flex flex-wrap items-center gap-4 rounded-md border p-3 text-sm">
          <span>
            {t('statement.charges')}: <strong>{money(totals.chargesTotal)}</strong>
          </span>
          <span>
            {t('statement.refunds')}: <strong>{money(totals.refundsTotal)}</strong>
          </span>
          <span>
            {t('statement.ignoredPreviousBalance')}:{' '}
            {data.itemsJson.ignoredPreviousBalance == null
              ? '—'
              : money(data.itemsJson.ignoredPreviousBalance)}
          </span>
          <span>
            {t('statement.ignoredPayments')}:{' '}
            {data.itemsJson.ignoredPayments == null ? '—' : money(data.itemsJson.ignoredPayments)}
          </span>
          <span>
            {t(`${NS}.statedTotal`)}:{' '}
            <strong>{data.statedTotal ? money(data.statedTotal) : '—'}</strong>
          </span>
          <span>
            {t(`${NS}.parsedTotal`)}: <strong>{money(totals.netTotal)}</strong>
          </span>
          {totals.delta !== null ? (
            <span
              className={deltaWarn ? 'text-amber-700 dark:text-amber-400' : 'text-muted-foreground'}
            >
              {t(`${NS}.delta`)}: {money(totals.delta)}
            </span>
          ) : null}
          {deltaWarn ? (
            <span className="flex items-center gap-1 text-amber-700 dark:text-amber-400">
              <TriangleAlert className="size-4" /> {t(`${NS}.deltaWarn`)}
            </span>
          ) : null}
        </div>

        {blockedGroups.length > 0 ? (
          <section className="space-y-2 rounded-md border border-destructive p-4 text-sm">
            <div className="flex items-center gap-2 font-medium text-destructive">
              <TriangleAlert className="size-4" />
              {t(`${NS}.blockedGroups`, { count: blockedGroups.length })}
            </div>
            <p className="text-muted-foreground">{t(`${NS}.blockedGroupsDescription`)}</p>
            <ul className="space-y-1">
              {blockedGroups.map((group) => (
                <li key={group.items.map(newItemKey).join('||')}>
                  {t(`${NS}.blockedGroupItem`, {
                    description: group.items[0]?.description ?? '—',
                    count: group.items.length,
                  })}
                </li>
              ))}
            </ul>
          </section>
        ) : null}

        {reversalBundles.length > 0 ? (
          <section className="space-y-2">
            <h3 className="font-heading text-base font-medium">
              {t(`${NS}.bucketReversals`, { count: reversalBundles.length })}
            </h3>
            {reversalBundles.map((bundle, index) => (
              <div
                key={`${newItemKey(bundle.refund)}|${bundle.charges.map(newItemKey).join('||')}`}
                className="rounded-md border border-amber-300 p-4 text-sm"
              >
                <div className="grid gap-3 md:grid-cols-3">
                  <div>
                    <p className="text-xs text-muted-foreground">
                      {t(`${NS}.reversalCharges`, { count: bundle.charges.length })}
                    </p>
                    <p className="font-medium">{money(bundle.chargesTotalBRL)}</p>
                  </div>
                  <div>
                    <p className="text-xs text-muted-foreground">{t(`${NS}.reversalCredit`)}</p>
                    <p className="font-medium text-emerald-700 dark:text-emerald-400">
                      -{money(bundle.creditTotalBRL)}
                    </p>
                  </div>
                  <div>
                    <p className="text-xs text-muted-foreground">{t(`${NS}.reversalNetRefund`)}</p>
                    <p className="font-medium">{money(bundle.netRefundBRL)}</p>
                  </div>
                </div>
                <p className="mt-3 text-muted-foreground">
                  {bundle.expected === null
                    ? t(`${NS}.reversalNoSchedule`)
                    : t(`${NS}.reversalSchedule`, {
                        description: bundle.expected.description,
                      })}
                </p>
                <div className="mt-3 flex flex-wrap gap-2">
                  <Button
                    size="sm"
                    variant={reversalChoices[index] === 'apply' ? 'default' : 'outline'}
                    onClick={() => setReversalChoices((state) => ({ ...state, [index]: 'apply' }))}
                  >
                    {t(`${NS}.applyReversal`)}
                  </Button>
                  <Button
                    size="sm"
                    variant={reversalChoices[index] === 'keep' ? 'default' : 'outline'}
                    onClick={() => setReversalChoices((state) => ({ ...state, [index]: 'keep' }))}
                  >
                    {t(`${NS}.keepSystem`)}
                  </Button>
                </div>
              </div>
            ))}
          </section>
        ) : null}

        <details className="rounded-md border p-3">
          <summary className="cursor-pointer text-sm font-medium">
            {t(`${NS}.bucketMatched`, { count: match.matched.length })}
          </summary>
          <ul className="mt-2 space-y-1 text-sm text-muted-foreground">
            {match.matched.map((pair) => (
              <li key={pair.expected.transactionId} className="flex justify-between gap-3">
                <span>{pair.parsed.description}</span>
                <span className="font-numeric tabular-nums">{money(pair.parsed.amountBRL)}</span>
              </li>
            ))}
          </ul>
        </details>

        <section className="space-y-2">
          <h3 className="font-heading text-base font-medium">
            {t(`${NS}.bucketReview`, { count: match.review.length })}
          </h3>
          {match.review.map((pair, index) => (
            <div key={pair.expected.transactionId} className="rounded-md border p-3 text-sm">
              <div className="flex flex-wrap gap-2">
                {pair.reasons.map((reason) => (
                  <Badge key={reason} variant="secondary">
                    {t(`${NS}.${reasonKeys[reason] ?? 'reasonValorDivergente'}`)}
                  </Badge>
                ))}
                {pair.parsed.isAdditional ? (
                  <Badge variant="outline">
                    {t(`${NS}.additionalBadge`, { holder: firstName(pair.parsed.holderName) })}
                  </Badge>
                ) : null}
              </div>
              <div className="mt-2 grid gap-2 sm:grid-cols-2">
                <div>
                  <p className="text-xs text-muted-foreground">{t(`${NS}.pdfValue`)}</p>
                  <p>
                    {pair.parsed.description} · {money(pair.parsed.amountBRL)}
                    {pair.parsed.installmentCurrent !== null &&
                    pair.parsed.installmentTotal !== null
                      ? ` · ${t(`${NS}.installmentShort`, {
                          current: pair.parsed.installmentCurrent,
                          total: pair.parsed.installmentTotal,
                        })}`
                      : ''}
                  </p>
                </div>
                <div>
                  <p className="text-xs text-muted-foreground">{t(`${NS}.systemValue`)}</p>
                  <p>
                    {pair.expected.description} · {money(pair.expected.amountBRL)}
                    {pair.expected.installmentNumber !== null &&
                    pair.expected.totalInstallments !== null
                      ? ` · ${t(`${NS}.installmentShort`, {
                          current: pair.expected.installmentNumber,
                          total: pair.expected.totalInstallments,
                        })}`
                      : ''}
                  </p>
                </div>
              </div>
              <div className="mt-3 flex flex-wrap gap-2">
                <Button
                  size="sm"
                  variant={reviewChoices[index] === 'accept' ? 'default' : 'outline'}
                  onClick={() => setReviewChoices((state) => ({ ...state, [index]: 'accept' }))}
                >
                  {t(`${NS}.acceptFatura`)}
                </Button>
                <Button
                  size="sm"
                  variant={reviewChoices[index] === 'keep' ? 'default' : 'outline'}
                  onClick={() => setReviewChoices((state) => ({ ...state, [index]: 'keep' }))}
                >
                  {t(`${NS}.keepSystem`)}
                </Button>
                {pair.expected.scheduleId &&
                  pair.expected.domainType !== 'credit_card_installment' &&
                  reviewChoices[index] === 'accept' && (
                    <Select
                      value={priceScopes[index] ?? 'cycle'}
                      onValueChange={(value) => {
                        if (value === 'cycle' || value === 'from_cycle')
                          setPriceScopes((state) => ({ ...state, [index]: value }));
                      }}
                    >
                      <SelectTrigger
                        className="w-full sm:w-auto"
                        aria-label={t('statement.priceScope')}
                      >
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="cycle">{t('statement.cycleOnly')}</SelectItem>
                        <SelectItem value="from_cycle">{t('statement.fromCycle')}</SelectItem>
                      </SelectContent>
                    </Select>
                  )}
              </div>
            </div>
          ))}
        </section>

        <section className="space-y-2">
          <h3 className="font-heading text-base font-medium">
            {t(`${NS}.bucketNew`, { count: suggestions.length })}
          </h3>
          {suggestions.map((suggestion, index) => {
            const state = newItem(index);
            const linked = linkedSuggestionIndexes.has(index);
            return (
              <div key={newItemKeys[index]} className="rounded-md border p-3 text-sm">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-numeric tabular-nums font-medium">
                    {money(suggestion.parsed.amountBRL)}
                  </span>
                  {suggestion.parsed.isRefund ? <Badge>{t(`${NS}.refundBadge`)}</Badge> : null}
                  {suggestion.looksRecurring ? (
                    <Badge variant="secondary">{t(`${NS}.looksRecurring`)}</Badge>
                  ) : null}
                  {suggestion.parsed.isAdditional ? (
                    <Badge variant="outline">
                      {t(`${NS}.additionalBadge`, {
                        holder: firstName(suggestion.parsed.holderName),
                      })}
                    </Badge>
                  ) : null}
                  {linked ? <Badge variant="secondary">{t(`${NS}.linkedBadge`)}</Badge> : null}
                </div>
                <div className="mt-2 flex flex-wrap items-center gap-2">
                  <Input
                    className="w-64"
                    disabled={linked}
                    value={state.description}
                    onChange={(event) =>
                      setNewItems((items) => ({
                        ...items,
                        [index]: { ...state, description: event.target.value },
                      }))
                    }
                  />
                  <Select
                    disabled={linked || !hasPositiveAmount(suggestion.parsed.amountBRL)}
                    value={state.kind}
                    onValueChange={(value) => {
                      if (!isNewKind(value)) return;
                      setNewItems((items) => ({ ...items, [index]: { ...state, kind: value } }));
                    }}
                  >
                    <SelectTrigger className="w-48">
                      <SelectValue>{t(`${NS}.${actionKeys[state.kind]}`)}</SelectValue>
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="skip">{t(`${NS}.actionSkip`)}</SelectItem>
                      <SelectItem value="add_expense">{t(`${NS}.actionAddExpense`)}</SelectItem>
                      <SelectItem value="add_installment">
                        {t(`${NS}.actionAddInstallment`)}
                      </SelectItem>
                      <SelectItem value="add_fixed_charge">
                        {t(`${NS}.actionAddFixedCharge`)}
                      </SelectItem>
                      <SelectItem value="add_refund">{t(`${NS}.actionAddRefund`)}</SelectItem>
                    </SelectContent>
                  </Select>
                  {suggestion.parsed.isAdditional ? (
                    <Select
                      disabled={linked}
                      value={state.targetCardAccountId}
                      onValueChange={(targetCardAccountId) =>
                        setNewItems((items) => ({
                          ...items,
                          [index]: { ...state, targetCardAccountId },
                        }))
                      }
                    >
                      <SelectTrigger className="w-48">
                        <SelectValue placeholder={t(`${NS}.selectTargetCard`)}>
                          {cardAccounts.find((card) => card.id === state.targetCardAccountId)?.name}
                        </SelectValue>
                      </SelectTrigger>
                      <SelectContent>
                        {cardAccounts.map((card) => (
                          <SelectItem key={card.id} value={card.id}>
                            {card.name}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  ) : null}
                  {state.kind === 'add_installment' ? (
                    <span className="flex items-center gap-1">
                      <Input
                        className="w-16"
                        type="number"
                        min={1}
                        value={state.current ?? 1}
                        onChange={(event) =>
                          setNewItems((items) => ({
                            ...items,
                            [index]: { ...state, current: Number(event.target.value) },
                          }))
                        }
                      />
                      /
                      <Input
                        className="w-16"
                        type="number"
                        min={2}
                        value={state.total ?? 2}
                        onChange={(event) =>
                          setNewItems((items) => ({
                            ...items,
                            [index]: { ...state, total: Number(event.target.value) },
                          }))
                        }
                      />
                    </span>
                  ) : null}
                </div>
              </div>
            );
          })}
        </section>

        <details className="rounded-md border border-amber-300 p-3">
          <summary className="cursor-pointer text-sm font-medium">
            {t(`${NS}.bucketMissing`, { count: match.missingInSystem.length })}
          </summary>
          {match.missingInSystem.length > 0 ? (
            <div className="mt-3 space-y-3">
              <p className="text-xs text-muted-foreground">{t(`${NS}.missingDescription`)}</p>
              {match.missingInSystem.map((item) => {
                const choice = missingChoices[item.transactionId];
                const linkedIndex = typeof choice === 'object' ? choice.suggestionIndex : null;
                const compatibleSuggestions = suggestions.flatMap((suggestion, index) => {
                  const usedByAnotherItem =
                    linkedSuggestionIndexes.has(index) && linkedIndex !== index;
                  return !usedByAnotherItem &&
                    canManuallyLinkFaturaItem({
                      parsed: suggestion.parsed,
                      expected: item,
                      targetCardAccountId: suggestion.targetCardAccountId,
                    })
                    ? [{ suggestion, index }]
                    : [];
                });
                return (
                  <div key={item.transactionId} className="space-y-3 rounded-md border p-3">
                    <div className="flex flex-wrap items-start justify-between gap-3">
                      <div className="space-y-2">
                        <p className="text-sm font-medium">{item.description}</p>
                        <div className="flex flex-wrap gap-2">
                          <Badge variant="secondary">
                            {t(`${NS}.${missingTypeKeys[item.domainType ?? ''] ?? 'typeOther'}`)}
                          </Badge>
                          {item.domainType === 'credit_card_installment' &&
                          item.installmentNumber !== null &&
                          item.totalInstallments !== null ? (
                            <Badge variant="outline">
                              {t(`${NS}.installmentShort`, {
                                current: item.installmentNumber,
                                total: item.totalInstallments,
                              })}
                            </Badge>
                          ) : null}
                          {item.isPaid === true ? (
                            <Badge variant="outline">{t(`${NS}.paidBadge`)}</Badge>
                          ) : null}
                        </div>
                      </div>
                      <span className="font-numeric text-sm font-medium tabular-nums">
                        {money(item.amountBRL)}
                      </span>
                    </div>
                    <p className="text-xs text-muted-foreground">
                      {item.isPaid === true
                        ? t(`${NS}.paidCannotRemove`)
                        : item.scheduleId === null
                          ? t(`${NS}.removeStandaloneConsequence`)
                          : t(`${NS}.removeScheduleConsequence`)}
                    </p>
                    {compatibleSuggestions.length > 0 ? (
                      <div className="max-w-2xl space-y-1">
                        <p className="text-xs text-muted-foreground">
                          {t(`${NS}.linkStatementDescription`)}
                        </p>
                        <Select
                          value={linkedIndex === null ? null : String(linkedIndex)}
                          onValueChange={(value) => {
                            if (value === null) return;
                            setMissingChoices((choices) => ({
                              ...choices,
                              [item.transactionId]: {
                                kind: 'link',
                                suggestionIndex: Number(value),
                              },
                            }));
                          }}
                        >
                          <SelectTrigger>
                            <SelectValue placeholder={t(`${NS}.selectStatementItem`)} />
                          </SelectTrigger>
                          <SelectContent>
                            {compatibleSuggestions.map(({ suggestion, index }) => (
                              <SelectItem key={newItemKeys[index]} value={String(index)}>
                                {suggestion.parsed.description} ·{' '}
                                {money(suggestion.parsed.amountBRL)}
                                {suggestion.parsed.installmentCurrent !== null &&
                                suggestion.parsed.installmentTotal !== null
                                  ? ` · ${t(`${NS}.installmentShort`, {
                                      current: suggestion.parsed.installmentCurrent,
                                      total: suggestion.parsed.installmentTotal,
                                    })}`
                                  : ''}
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      </div>
                    ) : null}
                    <div className="flex flex-wrap gap-2">
                      <Button
                        type="button"
                        size="sm"
                        variant={choice === 'keep' ? 'default' : 'outline'}
                        aria-pressed={choice === 'keep'}
                        onClick={() =>
                          setMissingChoices((choices) => ({
                            ...choices,
                            [item.transactionId]: 'keep',
                          }))
                        }
                      >
                        {t(`${NS}.keepMissing`)}
                      </Button>
                      <Button
                        type="button"
                        size="sm"
                        variant={choice === 'remove' ? 'destructive' : 'outline'}
                        aria-pressed={choice === 'remove'}
                        disabled={item.isPaid === true}
                        onClick={() =>
                          setMissingChoices((choices) => ({
                            ...choices,
                            [item.transactionId]: 'remove',
                          }))
                        }
                      >
                        {t(`${NS}.removeMissing`)}
                      </Button>
                    </div>
                  </div>
                );
              })}
            </div>
          ) : null}
        </details>

        <DialogFooter className="flex-col items-stretch gap-2 sm:flex-row sm:items-center">
          <span className="text-sm">
            {t(`${NS}.acceptedTotal`)}: <strong>{formatCurrency(acceptedCents / 100)}</strong>
          </span>
          {pendingReview ? (
            <span className="text-xs text-amber-700 dark:text-amber-400">
              {t(`${NS}.pendingDecision`)}
            </span>
          ) : null}
          {pendingReversal ? (
            <span className="text-xs text-amber-700 dark:text-amber-400">
              {t(`${NS}.pendingReversal`)}
            </span>
          ) : null}
          {pendingMissing ? (
            <span className="text-xs text-amber-700 dark:text-amber-400">
              {t(`${NS}.pendingMissing`)}
            </span>
          ) : null}
          {blockedGroups.length > 0 ? (
            <span className="text-xs text-destructive">{t(`${NS}.blockedApply`)}</span>
          ) : null}
          {acceptedDeltaWarn ? (
            <label className="flex max-w-xl items-start gap-2 text-xs text-amber-700 dark:text-amber-400">
              <input
                className="mt-0.5 size-4"
                type="checkbox"
                checked={acknowledgeTotalMismatch}
                onChange={(event) => setAcknowledgeTotalMismatch(event.target.checked)}
              />
              {t(`${NS}.acknowledgeTotalMismatch`)}
            </label>
          ) : null}
          <div className="flex min-w-0 flex-col gap-2 sm:ml-auto sm:flex-row">
            <Button
              variant="outline"
              disabled={apply.isPending || discard.isPending}
              onClick={() => discard.mutate({ importId })}
            >
              {t(`${NS}.discard`)}
            </Button>
            <Button
              disabled={
                reviewedImportId !== importId ||
                pendingReview ||
                pendingReversal ||
                pendingMissing ||
                pendingTarget ||
                blockedGroups.length > 0 ||
                (acceptedDeltaWarn && !acknowledgeTotalMismatch) ||
                defaultSourceAccountId.length === 0 ||
                apply.isPending
              }
              onClick={() =>
                apply.mutate({
                  importId,
                  expenseAccountId: defaultSourceAccountId,
                  decisions: decisions(),
                  acknowledgeTotalMismatch,
                  reviewedPeriod: { month: data.billingMonth, year: data.billingYear },
                })
              }
            >
              {apply.isPending ? <Loader2 className="mr-2 size-4 animate-spin" /> : null}
              {t(`${NS}.apply`, { count: changeCount })}
            </Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
