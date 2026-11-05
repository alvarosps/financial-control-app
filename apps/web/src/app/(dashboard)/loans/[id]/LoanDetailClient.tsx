'use client';

import Decimal from 'decimal.js';

import { useLocale, useTranslations } from 'next-intl';
import { useState } from 'react';
import { toast } from 'sonner';
import { DeactivateLoanDialog } from '@/components/loans/detail/DeactivateLoanDialog';
import {
  EditLoanDialog,
  type EditLoanForm,
  EMPTY_EDIT_LOAN_FORM,
} from '@/components/loans/detail/EditLoanDialog';
import { LoanActionsBar } from '@/components/loans/detail/LoanActionsBar';
import { LoanBalanceSummary } from '@/components/loans/detail/LoanBalanceSummary';
import { LoanDetailsSidebar } from '@/components/loans/detail/LoanDetailsSidebar';
import { LoanScheduleTable } from '@/components/loans/detail/LoanScheduleTable';
import { PayoffCalculatorCard } from '@/components/loans/detail/PayoffCalculatorCard';
import { ErrorAlert } from '@/components/shared/ErrorAlert';
import { MarkPaidWalletDialog } from '@/components/shared/MarkPaidWalletDialog';
import { SkeletonCard } from '@/components/shared/SkeletonCard';
import { usePageTitle } from '@/hooks/usePageTitle';
import { safeParseFloat } from '@/lib/parse';
import { invalidateDashboard, trpc } from '@/lib/trpc/client';
import { toArray } from '@/lib/utils';

export function LoanDetailClient({ accountId }: { accountId: string }) {
  const locale = useLocale();
  const t = useTranslations();

  const [showEdit, setShowEdit] = useState(false);
  const [editForm, setEditForm] = useState<EditLoanForm>(EMPTY_EDIT_LOAN_FORM);
  const [showDeactivate, setShowDeactivate] = useState(false);
  const [showMarkPaid, setShowMarkPaid] = useState(false);
  const [paidFromAccountId, setPaidFromAccountId] = useState('');

  const { data, isLoading } = trpc.loan.getById.useQuery({ accountId });
  usePageTitle(data?.account?.name ?? t('pageTitles.loans'));
  const { data: nextPayable } = trpc.loan.getNextPayable.useQuery(
    { accountId },
    { enabled: showMarkPaid },
  );
  const { data: rawAccounts } = trpc.account.list.useQuery();
  const allAccounts = toArray(rawAccounts);
  const checkingAccounts = allAccounts.filter(
    (a) => (a.type === 'checking' || a.type === 'savings') && a.isActive,
  );

  const utils = trpc.useUtils();
  const onError = (error: { message: string }) => {
    toast.error(error.message || t('common.saveFailed'));
  };

  const markAsPaid = trpc.loan.markCurrentAsPaid.useMutation({
    onSuccess: () => {
      utils.loan.getById.invalidate({ accountId });
      utils.loan.list.invalidate();
      utils.loan.getPayoff.invalidate({ accountId });
      invalidateDashboard(utils);
      utils.account.list.invalidate();
      setShowMarkPaid(false);
      setPaidFromAccountId('');
      toast.success(t('app-dashboard-loans-id-page.installmentMarkedAsPaid'));
    },
    onError,
  });
  const advanceMonth = trpc.loan.advanceMonth.useMutation({
    onSuccess: () => {
      utils.loan.getById.invalidate({ accountId });
      utils.loan.list.invalidate();
      utils.loan.getPayoff.invalidate({ accountId });
      toast.success(t('app-dashboard-loans-id-page.monthAdvancedSuccessfully'));
    },
    onError,
  });

  const updateLoan = trpc.loan.update.useMutation({
    onSuccess: () => {
      utils.loan.getById.invalidate({ accountId });
      utils.loan.list.invalidate();
      utils.loan.getPayoff.invalidate({ accountId });
      setShowEdit(false);
      setEditForm(EMPTY_EDIT_LOAN_FORM);
    },
    onError,
  });

  const deactivateLoan = trpc.loan.deactivate.useMutation({
    onMutate: async (vars) => {
      await utils.loan.list.cancel();
      const prev = utils.loan.list.getData();
      utils.loan.list.setData(undefined, (old) =>
        old ? old.filter((item) => item.account.id !== vars.accountId) : old,
      );
      return { prev };
    },
    onError: (error, _vars, ctx) => {
      if (ctx?.prev) utils.loan.list.setData(undefined, ctx.prev);
      onError(error);
    },
    onSuccess: () => {
      setShowDeactivate(false);
    },
    onSettled: () => {
      utils.loan.list.invalidate();
      utils.loan.getById.invalidate({ accountId });
      utils.loan.getPayoff.invalidate({ accountId });
    },
  });

  if (isLoading) {
    return (
      <div className="space-y-6">
        <SkeletonCard />
        <div className="grid grid-cols-1 lg:grid-cols-[1fr_320px] gap-6">
          <SkeletonCard />
          <SkeletonCard />
        </div>
      </div>
    );
  }

  if (!data) {
    return <ErrorAlert message={t('app-dashboard-loans-id-page.loanNotFound')} />;
  }

  const { account, config, payoff, isCurrentMonthPaid } = data;
  if (!config) {
    return <ErrorAlert message={t('app-dashboard-loans-id-page.configurationNotFound')} />;
  }

  const monthlyPayment = safeParseFloat(config.monthlyPayment);
  const insurance = config.insuranceAmount ? safeParseFloat(config.insuranceAmount) : 0;
  const totalMonthly = monthlyPayment + insurance;
  const total = config.totalInstallments;
  const current = config.currentInstallment ?? 0;
  const remaining = payoff?.remainingInstallments ?? Math.max(0, total - current + 1);
  const paid = total - remaining;
  const pct = total > 0 ? Math.round((paid / total) * 100) : 0;
  const monthlyRate = config.monthlyInterestRate
    ? safeParseFloat(config.monthlyInterestRate)
    : null;
  const totalRemaining = totalMonthly * remaining;

  const handleOpenEdit = () => {
    setEditForm({
      name: account.name,
      monthlyPayment: config.monthlyPayment ?? '',
      dueDay: config.dueDay?.toString() ?? '',
      comment: config.comment ?? '',
      paymentMethod: config.paymentMethod,
      incomeSourceAccountId: config.incomeSourceAccountId,
      annualCetPercent:
        config.annualCet !== null ? new Decimal(config.annualCet).mul(100).toString() : '',
      annualCetSource: config.annualCetSource ?? '',
      annualCetObservedOn: config.annualCetObservedOn ?? '',
      payoffQuoteAmount: config.payoffQuoteAmount ?? '',
      payoffQuoteOn: config.payoffQuoteOn ?? '',
      payoffQuoteValidUntil: config.payoffQuoteValidUntil ?? '',
      payoffQuoteSource: config.payoffQuoteSource ?? '',
      economicResponsibility: config.economicResponsibility,
    });
    setShowEdit(true);
  };

  return (
    <div className="space-y-6">
      <LoanActionsBar
        accountName={account.name}
        paymentMethod={config.paymentMethod}
        loanCategory={config.loanCategory}
        loanType={config.loanType}
        comment={config.comment}
        isQuitado={current >= total && isCurrentMonthPaid}
        isAdvancing={advanceMonth.isPending}
        canAdvance={current < total}
        onMarkAsPaid={() => {
          const defaultWalletId =
            checkingAccounts.find((a) => a.isDefaultWallet)?.id ?? checkingAccounts[0]?.id ?? '';
          setPaidFromAccountId(defaultWalletId);
          setShowMarkPaid(true);
        }}
        onAdvanceMonth={() => advanceMonth.mutate({ accountId })}
        onEdit={handleOpenEdit}
        onDeactivate={() => setShowDeactivate(true)}
      />

      <div className="grid grid-cols-1 lg:grid-cols-[1fr_320px] gap-6">
        <div className="space-y-6">
          <LoanBalanceSummary
            current={current}
            total={total}
            paid={paid}
            remaining={remaining}
            pct={pct}
            monthlyPayment={monthlyPayment}
            insurance={insurance}
            totalMonthly={totalMonthly}
            totalRemaining={totalRemaining}
          />

          {payoff && (
            <PayoffCalculatorCard
              payoff={payoff}
              loanType={config.loanType}
              totalRemaining={totalRemaining}
            />
          )}

          <LoanScheduleTable remaining={remaining} totalMonthly={totalMonthly} />
        </div>

        <LoanDetailsSidebar
          config={config}
          total={total}
          current={current}
          insurance={insurance}
          monthlyRate={monthlyRate}
        />
      </div>

      <MarkPaidWalletDialog
        open={showMarkPaid}
        onOpenChange={setShowMarkPaid}
        paidFromAccountId={paidFromAccountId}
        setPaidFromAccountId={setPaidFromAccountId}
        checkingAccounts={checkingAccounts.map((a) => ({ id: a.id, name: a.name }))}
        targetLabel={
          nextPayable
            ? t('loans.markPaidTarget', {
                n: nextPayable.installmentNumber ?? 0,
                total: nextPayable.totalInstallments ?? 0,
                date: new Date(`${nextPayable.date}T00:00:00Z`).toLocaleDateString(locale, {
                  timeZone: 'UTC',
                }),
              })
            : undefined
        }
        onConfirm={() => markAsPaid.mutate({ accountId, paidFromAccountId })}
        isPending={markAsPaid.isPending}
      />

      <EditLoanDialog
        open={showEdit}
        onOpenChange={setShowEdit}
        form={editForm}
        setForm={setEditForm}
        placeholderName={account.name}
        isPending={updateLoan.isPending}
        onSubmit={(payload) => updateLoan.mutate({ accountId, ...payload })}
      />

      <DeactivateLoanDialog
        open={showDeactivate}
        onOpenChange={setShowDeactivate}
        accountName={account.name}
        onConfirm={() => deactivateLoan.mutate({ accountId })}
        isPending={deactivateLoan.isPending}
      />
    </div>
  );
}
