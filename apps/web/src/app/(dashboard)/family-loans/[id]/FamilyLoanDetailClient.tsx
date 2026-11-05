'use client';

import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { useState } from 'react';
import { toast } from 'sonner';
import { AddBorrowedCardDialog } from '@/components/family-loans/AddBorrowedCardDialog';
import { AddDiscountDialog } from '@/components/family-loans/AddDiscountDialog';
import { AddFixedChargeDialog } from '@/components/family-loans/AddFixedChargeDialog';
import { AddInstallmentDialog } from '@/components/family-loans/AddInstallmentDialog';
import { AddOneTimeChargeDialog } from '@/components/family-loans/AddOneTimeChargeDialog';
import type { ChargeItem } from '@/components/family-loans/detail/ChargeListSection';
import { ChargeListSection } from '@/components/family-loans/detail/ChargeListSection';
import { DeactivatePersonDialog } from '@/components/family-loans/detail/DeactivatePersonDialog';
import { DeleteItemDialog } from '@/components/family-loans/detail/DeleteItemDialog';
import {
  EditChargeDialog,
  type EditChargeTarget,
} from '@/components/family-loans/detail/EditChargeDialog';
import { EditPersonDialog } from '@/components/family-loans/detail/EditPersonDialog';
import { FamilyLoanActionsBar } from '@/components/family-loans/detail/FamilyLoanActionsBar';
import { FamilyLoanBalanceSummary } from '@/components/family-loans/detail/FamilyLoanBalanceSummary';
import {
  PaymentListSection,
  type ReversiblePayment,
} from '@/components/family-loans/detail/PaymentListSection';
import { ReversePaymentDialog } from '@/components/family-loans/detail/ReversePaymentDialog';
import {
  useFamilyLoanData,
  useSortedFamilyLoanItems,
} from '@/components/family-loans/detail/useFamilyLoanData';
import { MonthlyReportDialog } from '@/components/family-loans/MonthlyReportDialog';
import { RecordPaymentDialog } from '@/components/family-loans/RecordPaymentDialog';
import { SkeletonCard } from '@/components/shared/SkeletonCard';
import { usePageTitle } from '@/hooks/usePageTitle';
import { formatCurrencyValue } from '@/lib/format';
import { toDisplayNumber } from '@/lib/parse';
import { invalidateDashboard, trpc } from '@/lib/trpc/client';

type ActiveDialog =
  | 'card'
  | 'installment'
  | 'fixed'
  | 'oneTimeCharge'
  | 'recordPayment'
  | 'discount'
  | 'edit'
  | 'deactivate'
  | 'deleteItem'
  | 'editCharge'
  | 'monthlyReport'
  | 'reversePayment'
  | null;

export function FamilyLoanDetailClient({
  configId,
  initialMonth,
  initialYear,
}: {
  configId: string;
  initialMonth: number;
  initialYear: number;
}) {
  const t = useTranslations();
  const router = useRouter();

  const utils = trpc.useUtils();

  const {
    month,
    year,
    getById: { data, isLoading, error },
    monthly,
    ledger,
    monthInstallments,
    monthFixedCharges,
    monthExpenses,
    monthDiscounts,
    cardNameMap,
    creditCardAccounts,
  } = useFamilyLoanData(configId, initialMonth, initialYear);

  usePageTitle(data?.account?.name ?? t('pageTitles.familyLoans'));

  const [activeDialog, setActiveDialog] = useState<ActiveDialog>(null);
  const [editName, setEditName] = useState('');
  const [editReceiptDay, setEditReceiptDay] = useState(10);
  const [deleteTarget, setDeleteTarget] = useState<{ id: string; name: string } | null>(null);
  const [editChargeTarget, setEditChargeTarget] = useState<EditChargeTarget | null>(null);
  const [reverseTarget, setReverseTarget] = useState<ReversiblePayment | null>(null);
  const [installmentSearch, setInstallmentSearch] = useState('');
  const [showAddMenu, setShowAddMenu] = useState(false);

  const invalidateAll = () => {
    utils.familyLoan.listWithTotals.invalidate();
    utils.familyLoan.getById.invalidate({ configId });
    utils.familyLoan.getMonthlyTotal.invalidate();
    utils.familyLoan.getLedger.invalidate({ configId, month, year });
    utils.familyLoan.get12MonthProjection.invalidate({ configId, month, year });
    utils.familyLoan.listItems.invalidate({ configId });
    invalidateDashboard(utils);
  };

  const updateMutation = trpc.familyLoan.update.useMutation({
    onSuccess: () => {
      invalidateAll();
      setActiveDialog(null);
      setEditName('');
    },
    onError: (error) => {
      toast.error(error.message || t('common.updateFailed'));
    },
  });

  const deactivateMutation = trpc.familyLoan.deactivate.useMutation({
    onSuccess: () => {
      invalidateAll();
      router.push('/family-loans');
    },
    onError: (error) => {
      toast.error(error.message || t('common.deactivateFailed'));
    },
  });

  const reversePaymentMutation = trpc.familyLoan.reversePayment.useMutation({
    onSuccess: () => {
      utils.familyLoan.getLedger.invalidate({ configId, month, year });
      utils.familyLoan.listPayments.invalidate({ configId });
      utils.familyLoan.listWithTotals.invalidate();
      utils.account.walletsOverview.invalidate();
      invalidateDashboard(utils);
      setActiveDialog(null);
      setReverseTarget(null);
    },
    onError: (error) => {
      toast.error(error.message || t('common.updateFailed'));
    },
  });

  const monthlyInput = { configId, month, year };

  const deleteItemMutation = trpc.scheduled.delete.useMutation({
    // The composition reads getMonthlyTotal.items; optimistically drop the row
    // for the deleted schedule (vars.id is the scheduledTransactionId).
    onMutate: async (vars) => {
      await utils.familyLoan.getMonthlyTotal.cancel(monthlyInput);
      const prev = utils.familyLoan.getMonthlyTotal.getData(monthlyInput);
      utils.familyLoan.getMonthlyTotal.setData(monthlyInput, (old) =>
        old
          ? {
              ...old,
              items: {
                installments: old.items.installments.filter(
                  (i) => i.scheduledTransactionId !== vars.id,
                ),
                fixedCharges: old.items.fixedCharges.filter(
                  (i) => i.scheduledTransactionId !== vars.id,
                ),
                expenses: old.items.expenses.filter((i) => i.scheduledTransactionId !== vars.id),
                discounts: old.items.discounts.filter((i) => i.scheduledTransactionId !== vars.id),
              },
            }
          : old,
      );
      return { prev };
    },
    onError: (error, _vars, ctx) => {
      if (ctx?.prev) {
        utils.familyLoan.getMonthlyTotal.setData(monthlyInput, ctx.prev);
      }
      toast.error(error.message || t('common.deleteItemFailed'));
    },
    onSuccess: () => {
      setActiveDialog(null);
      setDeleteTarget(null);
    },
    onSettled: () => {
      invalidateAll();
    },
  });

  const { sorted: sortedInstallments, filtered: filteredInstallments } = useSortedFamilyLoanItems(
    monthInstallments,
    installmentSearch,
  );
  const { sorted: sortedDiscounts } = useSortedFamilyLoanItems(monthDiscounts, '');

  if (isLoading) {
    return (
      <div className="space-y-6">
        <SkeletonCard />
        <SkeletonCard />
      </div>
    );
  }

  if (error) {
    return (
      <div className="rounded-xl glass border-expense/20 p-4 text-sm text-expense" role="alert">
        {t('app-dashboard-family-loans-id-page.error')} {error.message}
      </div>
    );
  }

  if (!data) {
    return (
      <div className="rounded-xl glass border-expense/20 p-4 text-sm text-expense">
        {t('app-dashboard-family-loans-id-page.loanNotFound')}
      </div>
    );
  }

  const { account, borrowedCards: cards } = data;

  const instTotal = monthly?.installments ?? 0;
  const fixedTotal = monthly?.fixedCharges ?? 0;
  const allExpenseItems = monthExpenses;
  const oneTimeChargeTotal = monthly?.oneTimeCharges ?? 0;
  const discountTotal = monthly?.discounts ?? 0;
  const cardTotal = monthly?.borrowedCardTotal ?? 0;

  const chargeTotal = instTotal + fixedTotal + oneTimeChargeTotal + cardTotal;
  const pctInst = chargeTotal > 0 ? (instTotal / chargeTotal) * 100 : 0;
  const pctFixed = chargeTotal > 0 ? (fixedTotal / chargeTotal) * 100 : 0;
  const pctOneTimeCharge = chargeTotal > 0 ? (oneTimeChargeTotal / chargeTotal) * 100 : 0;
  const pctCard = chargeTotal > 0 ? (cardTotal / chargeTotal) * 100 : 0;

  const handleDeleteItem = (id: string, name: string) => {
    setDeleteTarget({ id, name });
    setActiveDialog('deleteItem');
  };

  const handleEditItem = (item: ChargeItem) => {
    if (!item.scheduledTransactionId) return;
    setEditChargeTarget({
      scheduledTransactionId: item.scheduledTransactionId,
      description: item.description,
      amount: item.amount,
      domainType: item.domainType ?? null,
      installmentNumber: item.installmentNumber ?? null,
      totalInstallments: item.totalInstallments ?? null,
    });
    setActiveDialog('editCharge');
  };

  return (
    <div className="space-y-6">
      <FamilyLoanActionsBar
        accountName={account.name}
        showAddMenu={showAddMenu}
        onToggleAddMenu={() => setShowAddMenu((v) => !v)}
        onEdit={() => {
          setEditName(account.name);
          setEditReceiptDay(data.config.receiptDay);
          setActiveDialog('edit');
        }}
        onMonthlyReport={() => setActiveDialog('monthlyReport')}
        onDeactivate={() => setActiveDialog('deactivate')}
        onAddCard={() => {
          setActiveDialog('card');
          setShowAddMenu(false);
        }}
        onAddInstallment={() => {
          setActiveDialog('installment');
          setShowAddMenu(false);
        }}
        onAddFixed={() => {
          setActiveDialog('fixed');
          setShowAddMenu(false);
        }}
        onAddOneTimeCharge={() => {
          setActiveDialog('oneTimeCharge');
          setShowAddMenu(false);
        }}
        onRecordPayment={() => {
          setActiveDialog('recordPayment');
          setShowAddMenu(false);
        }}
        onAddDiscount={() => {
          setActiveDialog('discount');
          setShowAddMenu(false);
        }}
      />

      {monthly && <FamilyLoanBalanceSummary monthly={monthly} cardCount={cards.length} />}

      <ChargeListSection
        chargeTotal={chargeTotal}
        discountTotal={discountTotal}
        instTotal={instTotal}
        fixedTotal={fixedTotal}
        oneTimeChargeTotal={oneTimeChargeTotal}
        cardTotal={cardTotal}
        pctInst={pctInst}
        pctCard={pctCard}
        pctFixed={pctFixed}
        pctOneTimeCharge={pctOneTimeCharge}
        sortedInstallments={sortedInstallments}
        filteredInstallments={filteredInstallments}
        installmentSearch={installmentSearch}
        onInstallmentSearchChange={setInstallmentSearch}
        cards={cards}
        cardNameMap={cardNameMap}
        borrowedCardBreakdown={monthly?.borrowedCardBreakdown ?? []}
        fixedChargeItems={monthFixedCharges}
        expenseItems={allExpenseItems}
        sortedDiscounts={sortedDiscounts}
        ledger={ledger}
        month={month}
        year={year}
        onDeleteItem={handleDeleteItem}
        onEditItem={handleEditItem}
      />

      {ledger && (
        <PaymentListSection
          ledger={ledger}
          isReversing={reversePaymentMutation.isPending}
          onReversePayment={(payment) => {
            setReverseTarget(payment);
            setActiveDialog('reversePayment');
          }}
        />
      )}

      <AddBorrowedCardDialog
        open={activeDialog === 'card'}
        onOpenChange={(open) => {
          if (!open) setActiveDialog(null);
        }}
        configId={configId}
        creditCardAccounts={creditCardAccounts}
        onSuccess={invalidateAll}
      />
      <AddInstallmentDialog
        open={activeDialog === 'installment'}
        onOpenChange={(open) => {
          if (!open) setActiveDialog(null);
        }}
        configId={configId}
        onSuccess={invalidateAll}
      />
      <AddFixedChargeDialog
        open={activeDialog === 'fixed'}
        onOpenChange={(open) => {
          if (!open) setActiveDialog(null);
        }}
        configId={configId}
        onSuccess={invalidateAll}
      />
      <AddOneTimeChargeDialog
        open={activeDialog === 'oneTimeCharge'}
        onOpenChange={(open) => {
          if (!open) setActiveDialog(null);
        }}
        configId={configId}
        onSuccess={invalidateAll}
      />
      <RecordPaymentDialog
        open={activeDialog === 'recordPayment'}
        onOpenChange={(open) => {
          if (!open) setActiveDialog(null);
        }}
        configId={configId}
        onSuccess={invalidateAll}
      />
      <AddDiscountDialog
        open={activeDialog === 'discount'}
        onOpenChange={(open) => {
          if (!open) setActiveDialog(null);
        }}
        configId={configId}
        onSuccess={invalidateAll}
      />

      <MonthlyReportDialog
        open={activeDialog === 'monthlyReport'}
        onOpenChange={(open) => {
          if (!open) setActiveDialog(null);
        }}
        configId={configId}
        initialMonth={month}
        initialYear={year}
        cardNameMap={cardNameMap}
      />

      <EditPersonDialog
        open={activeDialog === 'edit'}
        onOpenChange={(open) => {
          if (!open) {
            setActiveDialog(null);
            setEditName('');
          }
        }}
        value={editName}
        onChange={setEditName}
        receiptDay={editReceiptDay}
        onReceiptDayChange={setEditReceiptDay}
        isPending={updateMutation.isPending}
        onSubmit={(trimmed) =>
          updateMutation.mutate({
            configId,
            personName: trimmed,
            receiptDay: Math.min(Math.max(Math.trunc(editReceiptDay) || 10, 1), 31),
          })
        }
        onCancel={() => {
          setActiveDialog(null);
          setEditName('');
        }}
      />

      <DeactivatePersonDialog
        open={activeDialog === 'deactivate'}
        onOpenChange={(open) => {
          if (!open) setActiveDialog(null);
        }}
        accountName={account.name}
        onConfirm={() => deactivateMutation.mutate({ configId })}
        onCancel={() => setActiveDialog(null)}
        isPending={deactivateMutation.isPending}
      />

      <EditChargeDialog
        open={activeDialog === 'editCharge'}
        onOpenChange={(open) => {
          if (!open) {
            setActiveDialog(null);
            setEditChargeTarget(null);
          }
        }}
        target={editChargeTarget}
        billMonth={month}
        billYear={year}
        onSuccess={() => {
          invalidateAll();
          setActiveDialog(null);
          setEditChargeTarget(null);
        }}
      />

      <DeleteItemDialog
        open={activeDialog === 'deleteItem'}
        onOpenChange={(open) => {
          if (!open) {
            setActiveDialog(null);
            setDeleteTarget(null);
          }
        }}
        itemName={deleteTarget?.name ?? ''}
        onConfirm={() => {
          if (deleteTarget) {
            deleteItemMutation.mutate({ id: deleteTarget.id });
          }
        }}
        onCancel={() => {
          setActiveDialog(null);
          setDeleteTarget(null);
        }}
        isPending={deleteItemMutation.isPending}
      />

      <ReversePaymentDialog
        open={activeDialog === 'reversePayment'}
        onOpenChange={(open) => {
          if (!open) {
            setActiveDialog(null);
            setReverseTarget(null);
          }
        }}
        amountLabel={
          reverseTarget ? formatCurrencyValue(toDisplayNumber(reverseTarget.amount)) : ''
        }
        onConfirm={() => {
          if (reverseTarget) {
            reversePaymentMutation.mutate({ transactionId: reverseTarget.id });
          }
        }}
        onCancel={() => {
          setActiveDialog(null);
          setReverseTarget(null);
        }}
        isPending={reversePaymentMutation.isPending}
      />
    </div>
  );
}
