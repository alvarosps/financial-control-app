import type {
  AmountMeaning,
  EventConfirmation,
  PurchaseApplication,
  PurchaseReview,
} from '@fc/shared';
import { Money } from './money.ts';

export function resolveEventRevision(
  currentVersion: number,
  currentHash: string,
  incomingVersion: number,
  incomingHash: string,
) {
  if (!Number.isSafeInteger(incomingVersion) || incomingVersion < 1)
    throw new Error('Invalid source revision');
  if (incomingVersion < currentVersion) return 'stale' as const;
  if (incomingVersion > currentVersion) return 'advance' as const;
  if (currentHash !== incomingHash)
    throw new Error('Source revision conflicts with existing content');
  return 'replay' as const;
}

export function transitionObservation(
  current: { review: PurchaseReview; application: PurchaseApplication; manuallyCorrected: boolean },
  confirmation: EventConfirmation,
  financialChanged: boolean,
) {
  const protectedFields =
    current.manuallyCorrected ||
    current.application !== 'unapplied' ||
    current.review === 'accepted' ||
    current.review === 'ignored';
  const review: PurchaseReview =
    current.review === 'ignored'
      ? 'ignored'
      : confirmation === 'retracted' || (financialChanged && protectedFields)
        ? 'needs_review'
        : current.review;
  return { review, application: current.application, updateFields: !protectedFields };
}

export function purchaseApplicationAmounts(input: {
  amount: string;
  currency: string;
  amountMeaning: AmountMeaning;
  installmentNumber: number | null;
  totalInstallments: number | null;
}) {
  if (input.amountMeaning === 'unknown')
    throw new Error('Identify whether the amount is total or installment');
  if (!/^\d{1,12}(\.\d{1,2})?$/.test(input.amount)) throw new Error('Invalid purchase amount');
  const amount = Money.fromString(input.amount, input.currency);
  if (amount.isZero()) throw new Error('Purchase amount must be positive');
  const installmentNumber = input.installmentNumber ?? 1;
  const totalInstallments = input.totalInstallments ?? 1;
  if (
    (input.installmentNumber === null) !== (input.totalInstallments === null) ||
    !Number.isInteger(installmentNumber) ||
    !Number.isInteger(totalInstallments) ||
    installmentNumber < 1 ||
    installmentNumber > totalInstallments ||
    totalInstallments > 120 ||
    (input.amountMeaning === 'installment' && input.totalInstallments === null)
  ) {
    throw new Error('Invalid installment identity');
  }
  const installment =
    input.amountMeaning === 'installment' ? amount : amount.divide(totalInstallments);
  const total = installment.multiply(totalInstallments);
  if (input.amountMeaning === 'purchase_total' && !total.equals(amount))
    throw new Error('Confirm the actual installment amount; total cannot be split exactly');
  return {
    installmentAmount: installment.toDbString(),
    totalAmount: total.toDbString(),
    installmentNumber,
    totalInstallments,
  };
}
