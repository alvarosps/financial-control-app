'use client';

import { AddAdditionalCardDialog } from '@/components/credit-cards/detail/dialogs/AddAdditionalCardDialog';
import { AddExpenseDialog } from '@/components/credit-cards/detail/dialogs/AddExpenseDialog';
import { AddInstallmentDialog } from '@/components/credit-cards/detail/dialogs/AddInstallmentDialog';
import { AddRefundDialog } from '@/components/credit-cards/detail/dialogs/AddRefundDialog';
import { DeleteConfirmDialog } from '@/components/credit-cards/detail/dialogs/DeleteConfirmDialog';
import { EditCreditCardDialog } from '@/components/credit-cards/detail/dialogs/EditCreditCardDialog';
import { EditItemDialog } from '@/components/credit-cards/detail/dialogs/EditItemDialog';
import {
  type EditableTransaction,
  EditTransactionDialog,
} from '@/components/credit-cards/detail/dialogs/EditTransactionDialog';
import { PayBillDialog } from '@/components/credit-cards/detail/dialogs/PayBillDialog';

export type DialogKey =
  | 'installment'
  | 'expense'
  | 'refund'
  | 'edit'
  | 'edit-card'
  | 'edit-transaction'
  | 'delete'
  | 'pay'
  | 'additional'
  | null;

export type DeleteTarget = { id: string; name: string; type: 'scheduled' | 'refund' } | null;

type Props = {
  cardId: string;
  openDialog: DialogKey;
  setOpenDialog: (d: DialogKey) => void;
  editItemId: string | null;
  setEditItemId: (id: string | null) => void;
  editCurrentInstallment: number | null;
  editCurrentAmount: string | null;
  deleteTarget: DeleteTarget;
  setDeleteTarget: (t: DeleteTarget) => void;
  closingDay: number;
  dueDay: number;
  defaultSourceAccountId: string;
  categories: { id: string; name: string }[];
  billMonth: number;
  billYear: number;
  billTotal: number;
  paymentAmount?: number;
  paymentAccounts: { id: string; name: string }[];
  onConfirmDelete: () => void;
  deleteLoading: boolean;
  editCardAccount: { id: string; name: string; color?: string | null } | null;
  editCardConfig: {
    closingDay: number;
    dueDay: number;
    creditLimit?: string | null;
    isDueDayVariable?: boolean | null;
  } | null;
  editTransaction: EditableTransaction | null;
  setEditTxId: (id: string | null) => void;
};

export function DetailDialogs({
  cardId,
  openDialog,
  setOpenDialog,
  editItemId,
  setEditItemId,
  editCurrentInstallment,
  editCurrentAmount,
  deleteTarget,
  setDeleteTarget,
  closingDay,
  dueDay,
  defaultSourceAccountId,
  categories,
  billMonth,
  billYear,
  billTotal,
  paymentAmount,
  paymentAccounts,
  onConfirmDelete,
  deleteLoading,
  editCardAccount,
  editCardConfig,
  editTransaction,
  setEditTxId,
}: Props) {
  return (
    <>
      <AddInstallmentDialog
        open={openDialog === 'installment'}
        onOpenChange={(open) => {
          if (!open) setOpenDialog(null);
        }}
        cardId={cardId}
        defaultSourceAccountId={defaultSourceAccountId}
        closingDay={closingDay}
        dueDay={dueDay}
        categories={categories}
      />
      <AddExpenseDialog
        open={openDialog === 'expense'}
        onOpenChange={(open) => {
          if (!open) setOpenDialog(null);
        }}
        cardId={cardId}
        defaultSourceAccountId={defaultSourceAccountId}
        closingDay={closingDay}
        dueDay={dueDay}
        categories={categories}
      />
      <AddRefundDialog
        open={openDialog === 'refund'}
        onOpenChange={(open) => {
          if (!open) setOpenDialog(null);
        }}
        cardId={cardId}
        defaultSourceAccountId={defaultSourceAccountId}
        billMonth={billMonth}
        billYear={billYear}
      />
      <EditItemDialog
        open={openDialog === 'edit'}
        onOpenChange={(open) => {
          if (!open) {
            setOpenDialog(null);
            setEditItemId(null);
          }
        }}
        itemId={editItemId}
        categories={categories}
        currentInstallment={editCurrentInstallment}
        currentAmount={editCurrentAmount}
        billMonth={billMonth}
        billYear={billYear}
      />
      <EditTransactionDialog
        open={openDialog === 'edit-transaction'}
        onOpenChange={(open) => {
          if (!open) {
            setOpenDialog(null);
            setEditTxId(null);
          }
        }}
        transaction={editTransaction}
        categories={categories}
      />
      <EditCreditCardDialog
        open={openDialog === 'edit-card'}
        onOpenChange={(open) => {
          if (!open) setOpenDialog(null);
        }}
        account={editCardAccount}
        config={editCardConfig}
      />
      <PayBillDialog
        open={openDialog === 'pay'}
        onOpenChange={(open) => {
          if (!open) setOpenDialog(null);
        }}
        cardId={cardId}
        month={billMonth}
        year={billYear}
        billTotal={billTotal}
        paymentAmount={paymentAmount}
        paymentAccounts={paymentAccounts}
      />
      <AddAdditionalCardDialog
        open={openDialog === 'additional'}
        onOpenChange={(open) => {
          if (!open) setOpenDialog(null);
        }}
        parentCardId={cardId}
      />
      <DeleteConfirmDialog
        open={openDialog === 'delete'}
        onOpenChange={(open) => {
          if (!open) {
            setOpenDialog(null);
            setDeleteTarget(null);
          }
        }}
        itemName={deleteTarget?.name ?? ''}
        onConfirm={onConfirmDelete}
        isLoading={deleteLoading}
      />
    </>
  );
}
