import Decimal from 'decimal.js';
import { compactMerchantText, normalizeMerchantText, tokenSimilarity } from './normalize-text.ts';
import type {
  ExpectedItem,
  InstallmentReversalAnalysis,
  InstallmentReversalBundle,
  ParsedItem,
} from './types.ts';

type ReversalInput = {
  parsed: ParsedItem[];
  expected: ExpectedItem[];
  paidTotalsBySchedule: Record<string, string>;
};

type IndexedItem = { index: number; item: ParsedItem };

const AMOUNT_TOLERANCE = new Decimal('0.20');

export function analyzeInstallmentReversals(input: ReversalInput): InstallmentReversalAnalysis {
  const groups = collectInstallmentGroups(input.parsed);
  const usedParsed = new Set<number>();
  const usedExpected = new Set<number>();
  const reversalBundles: InstallmentReversalBundle[] = [];
  const blockedGroups: InstallmentReversalAnalysis['blockedGroups'] = [];

  for (const group of groups) {
    const sorted = [...group].sort(
      (left, right) => (left.item.installmentCurrent ?? 0) - (right.item.installmentCurrent ?? 0),
    );
    const currents = sorted.map(({ item }) => item.installmentCurrent ?? 0);
    if (!isUniqueContiguous(currents)) continue;

    const first = sorted[0]?.item;
    if (first === undefined) continue;
    const totalInstallments = first.installmentTotal ?? 0;
    const reachesFinalInstallment = currents.at(-1) === totalInstallments;
    const expectedCandidates = reachesFinalInstallment
      ? findExpectedCandidates(first, currents[0] ?? 0, input.expected, usedExpected)
      : [];
    const chargesTotal = sumAmounts(sorted.map(({ item }) => item));
    const bundleCandidates = reachesFinalInstallment
      ? findBundleCandidates(sorted, chargesTotal, expectedCandidates, input, usedParsed)
      : [];

    if (bundleCandidates.length !== 1) {
      blockedGroups.push({
        items: sorted.map(({ item }) => item),
        reason: 'multiple_installments_same_purchase',
      });
      sorted.forEach(({ index }) => {
        usedParsed.add(index);
      });
      continue;
    }

    const candidate = bundleCandidates[0];
    if (candidate === undefined) continue;
    const primaryRefund = candidate.refunds[0];
    if (primaryRefund === undefined) continue;
    sorted.forEach(({ index }) => {
      usedParsed.add(index);
    });
    candidate.refunds.forEach(({ index }) => {
      usedParsed.add(index);
    });
    if (candidate.expectedIndex !== null) usedExpected.add(candidate.expectedIndex);
    reversalBundles.push({
      charges: sorted.map(({ item }) => item),
      refund: primaryRefund.item,
      ...(candidate.refunds.length > 1
        ? { refunds: candidate.refunds.map(({ item }) => item) }
        : {}),
      expected:
        candidate.expectedIndex === null ? null : (input.expected[candidate.expectedIndex] ?? null),
      chargesTotalBRL: chargesTotal.toFixed(2),
      creditTotalBRL: sumAmounts(candidate.refunds.map(({ item }) => item)).toFixed(2),
      netRefundBRL: candidate.netRefund.toFixed(2),
    });
  }

  return {
    parsed: input.parsed.filter((_, index) => !usedParsed.has(index)),
    expected: input.expected.filter((_, index) => !usedExpected.has(index)),
    reversalBundles,
    blockedGroups,
  };
}

function collectInstallmentGroups(parsed: ParsedItem[]): IndexedItem[][] {
  const groups = new Map<string, IndexedItem[]>();
  parsed.forEach((item, index) => {
    if (
      item.isRefund ||
      item.purchaseDate === null ||
      item.installmentCurrent === null ||
      item.installmentTotal === null ||
      item.installmentTotal <= 1
    ) {
      return;
    }
    const merchant = compactMerchantText(normalizeMerchantText(item.description));
    if (merchant.length === 0) return;
    const key = [
      item.cardLastFour ?? '',
      item.holderName ?? '',
      item.isAdditional ? 'additional' : 'principal',
      item.purchaseDate,
      item.installmentTotal,
      merchant,
    ].join('|');
    const group = groups.get(key) ?? [];
    group.push({ index, item });
    groups.set(key, group);
  });
  return [...groups.values()].filter((group) => group.length >= 2);
}

function isUniqueContiguous(currents: number[]): boolean {
  if (new Set(currents).size !== currents.length) return false;
  return currents.every(
    (current, index) => index === 0 || current === (currents[index - 1] ?? 0) + 1,
  );
}

function findExpectedCandidates(
  parsed: ParsedItem,
  current: number,
  expected: ExpectedItem[],
  usedExpected: Set<number>,
): number[] {
  const parsedText = normalizeMerchantText(parsed.description);
  return expected.flatMap((item, index) => {
    if (
      usedExpected.has(index) ||
      item.scheduleId === null ||
      item.domainType !== 'credit_card_installment' ||
      item.installmentNumber !== current ||
      item.totalInstallments !== parsed.installmentTotal ||
      new Decimal(item.amountBRL).minus(parsed.amountBRL).abs().gt(AMOUNT_TOLERANCE) ||
      tokenSimilarity(parsedText, normalizeMerchantText(item.description)) < 0.8
    ) {
      return [];
    }
    return [index];
  });
}

function findBundleCandidates(
  group: IndexedItem[],
  chargesTotal: Decimal,
  expectedCandidates: number[],
  input: ReversalInput,
  usedParsed: Set<number>,
): Array<{
  refunds: IndexedItem[];
  expectedIndex: number | null;
  netRefund: Decimal;
}> {
  const groupItem = group[0]?.item;
  if (groupItem === undefined) return [];
  const refunds = input.parsed.flatMap((item, index) => {
    if (usedParsed.has(index) || !item.isRefund || !sameCard(groupItem, item)) {
      return [];
    }
    return [{ index, item }];
  });
  const result: Array<{
    refunds: IndexedItem[];
    expectedIndex: number | null;
    netRefund: Decimal;
  }> = [];

  const addCandidates = (candidateRefunds: IndexedItem[]) => {
    const credit = sumAmounts(candidateRefunds.map(({ item }) => item));
    if (expectedCandidates.length === 0 && credit.eq(chargesTotal)) {
      result.push({ refunds: candidateRefunds, expectedIndex: null, netRefund: new Decimal(0) });
    }
    for (const expectedIndex of expectedCandidates) {
      const scheduleId = input.expected[expectedIndex]?.scheduleId;
      if (scheduleId === null || scheduleId === undefined) continue;
      const paidTotal = new Decimal(input.paidTotalsBySchedule[scheduleId] ?? '0');
      if (credit.eq(chargesTotal.plus(paidTotal))) {
        result.push({ refunds: candidateRefunds, expectedIndex, netRefund: paidTotal });
      }
    }
  };

  for (const refundItem of refunds) {
    addCandidates([refundItem]);
  }
  const pairedRefunds = findPairedRefunds(group, refunds);
  if (pairedRefunds !== null) addCandidates(pairedRefunds);
  return result;
}

function findPairedRefunds(group: IndexedItem[], refunds: IndexedItem[]): IndexedItem[] | null {
  const usedRefunds = new Set<number>();
  const result: IndexedItem[] = [];
  for (const charge of group) {
    const matches = refunds.filter(
      ({ index, item }) =>
        !usedRefunds.has(index) &&
        item.purchaseDate === charge.item.purchaseDate &&
        item.installmentCurrent === charge.item.installmentCurrent &&
        item.installmentTotal === charge.item.installmentTotal &&
        new Decimal(item.amountBRL).eq(charge.item.amountBRL),
    );
    if (matches.length !== 1) return null;
    const match = matches[0];
    if (match === undefined) return null;
    usedRefunds.add(match.index);
    result.push(match);
  }
  return result;
}

function sameCard(left: ParsedItem, right: ParsedItem): boolean {
  return (
    left.cardLastFour === right.cardLastFour &&
    left.holderName === right.holderName &&
    left.isAdditional === right.isAdditional
  );
}

function sumAmounts(items: ParsedItem[]): Decimal {
  return items.reduce((total, item) => total.plus(item.amountBRL), new Decimal(0));
}
