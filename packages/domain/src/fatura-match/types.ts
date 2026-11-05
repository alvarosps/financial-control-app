export type ParsedItem = {
  description: string;
  amountBRL: string;
  purchaseDate: string | null;
  postedDate?: string | null;
  installmentCurrent: number | null;
  installmentTotal: number | null;
  isRefund: boolean;
  cardLastFour: string | null;
  holderName: string | null;
  isAdditional: boolean;
};

export type ParsedCardItem = Omit<ParsedItem, 'cardLastFour' | 'holderName' | 'isAdditional'>;

export type ParsedCard = {
  lastFour: string | null;
  holderName: string | null;
  isAdditional: boolean;
  items: ParsedCardItem[];
};

export type ParsedFatura = {
  ignoredPreviousBalance?: string | null;
  ignoredPayments?: string | null;
  dueDate: string;
  closingDate?: string | null;
  statedTotal: string | null;
  cards: ParsedCard[];
};

export type ExpectedItem = {
  transactionId: string;
  cardAccountId: string;
  scheduleId: string | null;
  description: string;
  amountBRL: string;
  date: string;
  domainType: string | null;
  installmentNumber: number | null;
  totalInstallments: number | null;
  isPaid?: boolean;
};

export type AliasMap = Record<string, string>;

export type ReviewReason =
  | 'nome_aproximado'
  | 'valor_aproximado'
  | 'valor_divergente'
  | 'parcela_numero'
  | 'parcela_total'
  | 'parcela_ausente_na_fatura'
  | 'assinatura_preco';

export type MatchedPair = {
  parsed: ParsedItem;
  expected: ExpectedItem;
  score: number;
};

export type ReviewPair = MatchedPair & { reasons: ReviewReason[] };

export type FaturaMatchResult = {
  matched: MatchedPair[];
  review: ReviewPair[];
  newOnFatura: ParsedItem[];
  missingInSystem: ExpectedItem[];
};

export type FaturaMatchInput = {
  parsed: ParsedItem[];
  expected: ExpectedItem[];
  aliases: AliasMap;
  learnedScheduleIds?: Record<string, string>;
};

export type NewItemSuggestion = {
  parsed: ParsedItem;
  suggestedKind: 'add_expense' | 'add_installment' | 'add_refund' | 'add_fixed_charge';
  looksRecurring: boolean;
  targetCardAccountId?: string | null;
};

export type HistoryItem = {
  description: string;
  amountBRL: string;
  billingMonth: number;
  billingYear: number;
  domainType: string | null;
};

export type InstallmentReversalBundle = {
  charges: ParsedItem[];
  refund: ParsedItem;
  refunds?: ParsedItem[];
  expected: ExpectedItem | null;
  chargesTotalBRL: string;
  creditTotalBRL: string;
  netRefundBRL: string;
};

export type BlockedInstallmentGroup = {
  items: ParsedItem[];
  reason: 'multiple_installments_same_purchase';
};

export type InstallmentReversalAnalysis = {
  parsed: ParsedItem[];
  expected: ExpectedItem[];
  reversalBundles: InstallmentReversalBundle[];
  blockedGroups: BlockedInstallmentGroup[];
};
