import Decimal from 'decimal.js';
import { compactMerchantText, normalizeMerchantText, tokenSimilarity } from './normalize-text.ts';
import type {
  AliasMap,
  ExpectedItem,
  FaturaMatchInput,
  FaturaMatchResult,
  ParsedItem,
  ReviewReason,
} from './types.ts';

const AUTO_TEXT = 0.8;
const MAIN_TEXT = 0.55;
const STRONG_TEXT = 0.7;
const WEAK_TEXT = 0.3;
const EXACT_AMOUNT = new Decimal('0.01');
const REVIEW_AMOUNT = new Decimal('0.20');

type PairFacts = {
  text: number;
  merchantExact: boolean;
  amountDelta: Decimal;
  installmentNumberBoth: boolean;
  installmentNumberEqual: boolean;
  installmentTotalBoth: boolean;
  installmentTotalEqual: boolean;
};

type Candidate = PairFacts & { parsedIndex: number; expectedIndex: number; score: number };

function facts(
  parsed: ParsedItem,
  expected: ExpectedItem,
  text: number,
  merchantExact: boolean,
): PairFacts {
  const installmentNumberBoth =
    parsed.installmentCurrent !== null && expected.installmentNumber !== null;
  const installmentTotalBoth =
    parsed.installmentTotal !== null && expected.totalInstallments !== null;
  return {
    text,
    merchantExact,
    amountDelta: new Decimal(parsed.amountBRL).minus(expected.amountBRL).abs(),
    installmentNumberBoth,
    installmentNumberEqual:
      installmentNumberBoth && parsed.installmentCurrent === expected.installmentNumber,
    installmentTotalBoth,
    installmentTotalEqual:
      installmentTotalBoth && parsed.installmentTotal === expected.totalInstallments,
  };
}

function isCandidate(pair: PairFacts, expected: ExpectedItem): boolean {
  if (pair.text >= MAIN_TEXT && pair.amountDelta.lte(REVIEW_AMOUNT)) return true;
  if (pair.text >= STRONG_TEXT && expected.domainType === 'credit_card_fixed_charge') return true;
  if (
    pair.text >= STRONG_TEXT &&
    pair.installmentTotalEqual &&
    (pair.merchantExact || pair.installmentNumberEqual || pair.amountDelta.lte(REVIEW_AMOUNT))
  ) {
    return true;
  }
  return (
    pair.text >= WEAK_TEXT &&
    pair.amountDelta.lte(EXACT_AMOUNT) &&
    pair.installmentNumberEqual &&
    pair.installmentTotalEqual
  );
}

function score(pair: PairFacts, parsed: ParsedItem, expected: ExpectedItem): number {
  let result = pair.text;
  if (pair.merchantExact) result += 0.3;
  if (pair.amountDelta.lte(EXACT_AMOUNT)) result += 0.25;
  else if (pair.amountDelta.lte(REVIEW_AMOUNT)) result += 0.1;
  if (pair.installmentNumberEqual) result += 0.1;
  if (pair.installmentTotalEqual) result += 0.05;
  if (parsed.purchaseDate !== null) {
    const left = Date.parse(`${parsed.purchaseDate}T00:00:00Z`);
    const right = Date.parse(`${expected.date}T00:00:00Z`);
    if (Number.isFinite(left) && Number.isFinite(right) && Math.abs(left - right) <= 259_200_000) {
      result += 0.05;
    }
  }
  return result;
}

function statementOmitsExpectedInstallment(parsed: ParsedItem, expected: ExpectedItem): boolean {
  return (
    !parsed.isRefund &&
    parsed.installmentCurrent === null &&
    parsed.installmentTotal === null &&
    expected.domainType === 'credit_card_installment' &&
    expected.installmentNumber !== null &&
    expected.totalInstallments !== null
  );
}

function reasons(pair: PairFacts, parsed: ParsedItem, expected: ExpectedItem): ReviewReason[] {
  const result: ReviewReason[] = [];
  if (pair.text < AUTO_TEXT) result.push('nome_aproximado');
  if (pair.amountDelta.gt(EXACT_AMOUNT) && pair.amountDelta.lte(REVIEW_AMOUNT)) {
    result.push('valor_aproximado');
  } else if (pair.amountDelta.gt(REVIEW_AMOUNT)) {
    result.push(
      expected.domainType === 'credit_card_fixed_charge' ? 'assinatura_preco' : 'valor_divergente',
    );
  }
  if (pair.installmentNumberBoth && !pair.installmentNumberEqual) result.push('parcela_numero');
  if (pair.installmentTotalBoth && !pair.installmentTotalEqual) result.push('parcela_total');
  if (statementOmitsExpectedInstallment(parsed, expected)) {
    result.push('parcela_ausente_na_fatura');
  }
  return result;
}

function normalizedParsedText(item: ParsedItem, aliases: AliasMap): string {
  const normalized = normalizeMerchantText(item.description);
  const alias = aliases[normalized];
  return alias === undefined ? normalized : normalizeMerchantText(alias);
}

function hasInstallmentSignalFallback(parsed: ParsedItem, expected: ExpectedItem): boolean {
  return (
    !parsed.isRefund &&
    expected.domainType === 'credit_card_installment' &&
    parsed.installmentCurrent !== null &&
    expected.installmentNumber !== null &&
    parsed.installmentCurrent === expected.installmentNumber &&
    parsed.installmentTotal !== null &&
    expected.totalInstallments !== null &&
    parsed.installmentTotal === expected.totalInstallments &&
    new Decimal(parsed.amountBRL).minus(expected.amountBRL).abs().lte(REVIEW_AMOUNT)
  );
}

function hasStandaloneSignalFallback(parsed: ParsedItem, expected: ExpectedItem): boolean {
  return (
    !parsed.isRefund &&
    parsed.installmentCurrent === null &&
    parsed.installmentTotal === null &&
    (expected.domainType === 'credit_card_expense' ||
      expected.domainType === 'credit_card_fixed_charge') &&
    new Decimal(parsed.amountBRL).gt(0) &&
    new Decimal(parsed.amountBRL).minus(expected.amountBRL).abs().lte(EXACT_AMOUNT)
  );
}

function hasUnmarkedInstallmentFallback(parsed: ParsedItem, expected: ExpectedItem): boolean {
  return (
    statementOmitsExpectedInstallment(parsed, expected) &&
    new Decimal(parsed.amountBRL).gt(0) &&
    new Decimal(parsed.amountBRL).minus(expected.amountBRL).abs().lte(EXACT_AMOUNT)
  );
}

function hasUniqueFinancialSignalFallback(parsed: ParsedItem, expected: ExpectedItem): boolean {
  return (
    hasInstallmentSignalFallback(parsed, expected) ||
    hasStandaloneSignalFallback(parsed, expected) ||
    hasUnmarkedInstallmentFallback(parsed, expected)
  );
}

export function matchFaturaItems(input: FaturaMatchInput): FaturaMatchResult {
  const candidates: Candidate[] = [];
  input.parsed.forEach((parsed, parsedIndex) => {
    const parsedText = normalizedParsedText(parsed, input.aliases);
    const learnedScheduleId = input.learnedScheduleIds?.[normalizeMerchantText(parsed.description)];
    input.expected.forEach((expected, expectedIndex) => {
      if (parsed.isRefund !== (expected.domainType === 'credit_card_refund')) return;
      if (learnedScheduleId !== undefined && expected.scheduleId !== learnedScheduleId) return;
      const expectedText = normalizeMerchantText(expected.description);
      const text = learnedScheduleId === undefined ? tokenSimilarity(parsedText, expectedText) : 1;
      const merchantExact =
        learnedScheduleId !== undefined ||
        (compactMerchantText(parsedText).length > 0 &&
          compactMerchantText(parsedText) === compactMerchantText(expectedText));
      const pair = facts(parsed, expected, text, merchantExact);
      if (!isCandidate(pair, expected)) return;
      candidates.push({
        ...pair,
        parsedIndex,
        expectedIndex,
        score: score(pair, parsed, expected),
      });
    });
  });

  candidates.sort(
    (left, right) =>
      right.score - left.score ||
      left.amountDelta.comparedTo(right.amountDelta) ||
      left.parsedIndex - right.parsedIndex ||
      left.expectedIndex - right.expectedIndex,
  );

  const usedParsed = new Set<number>();
  const usedExpected = new Set<number>();
  const matched: FaturaMatchResult['matched'] = [];
  const review: FaturaMatchResult['review'] = [];

  for (const candidate of candidates) {
    if (usedParsed.has(candidate.parsedIndex) || usedExpected.has(candidate.expectedIndex))
      continue;
    const parsed = input.parsed[candidate.parsedIndex];
    const expected = input.expected[candidate.expectedIndex];
    if (parsed === undefined || expected === undefined) continue;
    usedParsed.add(candidate.parsedIndex);
    usedExpected.add(candidate.expectedIndex);
    const pairReasons = reasons(candidate, parsed, expected);
    const pair = { parsed, expected, score: candidate.score };
    if (pairReasons.length === 0) matched.push(pair);
    else review.push({ ...pair, reasons: pairReasons });
  }

  const unmatchedParsedIndexes = input.parsed.flatMap((_, index) =>
    usedParsed.has(index) ? [] : [index],
  );
  const unmatchedExpectedIndexes = input.expected.flatMap((_, index) =>
    usedExpected.has(index) ? [] : [index],
  );
  for (const parsedIndex of unmatchedParsedIndexes) {
    const parsed = input.parsed[parsedIndex];
    if (parsed === undefined) continue;
    const expectedCandidates = unmatchedExpectedIndexes.filter((expectedIndex) => {
      const expected = input.expected[expectedIndex];
      return expected !== undefined && hasUniqueFinancialSignalFallback(parsed, expected);
    });
    if (expectedCandidates.length !== 1) continue;
    const expectedIndex = expectedCandidates[0];
    if (expectedIndex === undefined) continue;
    const expected = input.expected[expectedIndex];
    if (expected === undefined) continue;
    const parsedCandidates = unmatchedParsedIndexes.filter((candidateIndex) => {
      const candidate = input.parsed[candidateIndex];
      return candidate !== undefined && hasUniqueFinancialSignalFallback(candidate, expected);
    });
    if (parsedCandidates.length !== 1) continue;

    const parsedText = normalizedParsedText(parsed, input.aliases);
    const expectedText = normalizeMerchantText(expected.description);
    const pair = facts(
      parsed,
      expected,
      tokenSimilarity(parsedText, expectedText),
      compactMerchantText(parsedText).length > 0 &&
        compactMerchantText(parsedText) === compactMerchantText(expectedText),
    );
    const pairReasons = reasons(pair, parsed, expected);
    review.push({
      parsed,
      expected,
      score: score(pair, parsed, expected),
      reasons: pairReasons.length > 0 ? pairReasons : ['nome_aproximado'],
    });
    usedParsed.add(parsedIndex);
    usedExpected.add(expectedIndex);
  }

  return {
    matched,
    review,
    newOnFatura: input.parsed.filter((_, index) => !usedParsed.has(index)),
    missingInSystem: input.expected.filter((_, index) => !usedExpected.has(index)),
  };
}
