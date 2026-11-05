import type { StatementDateSource } from '@fc/shared';
import { sql } from 'drizzle-orm';
import {
  check,
  date,
  index,
  integer,
  jsonb,
  numeric,
  pgTable,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from 'drizzle-orm/pg-core';
import { accounts } from './accounts.ts';
import { userProfiles } from './users.ts';

export type FaturaImportParsedItem = {
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

export type FaturaImportExpectedItem = {
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

export type FaturaImportReviewReason =
  | 'nome_aproximado'
  | 'valor_aproximado'
  | 'valor_divergente'
  | 'parcela_numero'
  | 'parcela_total'
  | 'parcela_ausente_na_fatura'
  | 'assinatura_preco';

export type FaturaImportSuggestedKind =
  | 'add_expense'
  | 'add_installment'
  | 'add_refund'
  | 'add_fixed_charge';

export type FaturaImportItemsJson = {
  snapshotHash?: string;
  ignoredPreviousBalance?: string | null;
  ignoredPayments?: string | null;
  reconciliation?: {
    status: 'reconciled' | 'difference' | 'unknown';
    compositionDelta: string | null;
    documentDelta: string | null;
    future: boolean;
    estimated: boolean;
  };
  cardAccounts: {
    id: string;
    name: string;
    parentAccountId: string | null;
  }[];
  matchResult: {
    matched: {
      parsed: FaturaImportParsedItem;
      expected: FaturaImportExpectedItem;
      score: number;
    }[];
    review: {
      parsed: FaturaImportParsedItem;
      expected: FaturaImportExpectedItem;
      score: number;
      reasons: FaturaImportReviewReason[];
    }[];
    newOnFatura: FaturaImportParsedItem[];
    missingInSystem: FaturaImportExpectedItem[];
  };
  suggestions: {
    parsed: FaturaImportParsedItem;
    suggestedKind: FaturaImportSuggestedKind;
    looksRecurring: boolean;
    targetCardAccountId: string | null;
  }[];
  reversalBundles?: {
    charges: FaturaImportParsedItem[];
    refund: FaturaImportParsedItem;
    refunds?: FaturaImportParsedItem[];
    expected: FaturaImportExpectedItem | null;
    chargesTotalBRL: string;
    creditTotalBRL: string;
    netRefundBRL: string;
  }[];
  blockedGroups?: {
    items: FaturaImportParsedItem[];
    reason: 'multiple_installments_same_purchase';
  }[];
  totals: {
    chargesTotal: string;
    refundsTotal: string;
    netTotal: string;
    delta: string | null;
  };
};

export const faturaImports = pgTable(
  'fatura_imports',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => userProfiles.id, { onDelete: 'cascade' }),
    cardAccountId: uuid('card_account_id')
      .notNull()
      .references(() => accounts.id, { onDelete: 'cascade' }),
    billingMonth: integer('billing_month').notNull(),
    billingYear: integer('billing_year').notNull(),
    dueDate: date('due_date').notNull(),
    status: varchar('status', { length: 20 }).notNull().default('draft'),
    fileName: varchar('file_name', { length: 255 }),
    profileId: varchar('profile_id', { length: 50 }).notNull(),
    modelUsed: varchar('model_used', { length: 100 }).notNull(),
    parsedTotal: numeric('parsed_total', { precision: 14, scale: 2 }).notNull(),
    statedTotal: numeric('stated_total', { precision: 14, scale: 2 }),
    itemsJson: jsonb('items_json').$type<FaturaImportItemsJson>().notNull(),
    appliedAt: timestamp('applied_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    closingDate: date('closing_date'),
    closingDateSource: varchar('closing_date_source', { length: 20 })
      .$type<StatementDateSource>()
      .notNull()
      .default('unknown'),
    dueDateSource: varchar('due_date_source', { length: 20 })
      .$type<StatementDateSource>()
      .notNull()
      .default('unknown'),
    periodConfidence: varchar('period_confidence', { length: 20 })
      .$type<'confirmed' | 'estimated' | 'unknown'>()
      .notNull()
      .default('unknown'),
    documentHash: varchar('document_hash', { length: 64 }),
  },
  (table) => [
    uniqueIndex('fatura_imports_document_unique')
      .on(table.userId, table.cardAccountId, table.documentHash)
      .where(sql`${table.documentHash} IS NOT NULL AND ${table.status} != 'discarded'`),
    index('fatura_imports_user_card_idx').on(
      table.userId,
      table.cardAccountId,
      table.billingYear,
      table.billingMonth,
    ),
    check('fatura_imports_status_check', sql`${table.status} in ('draft', 'applied', 'discarded')`),
    check('fatura_imports_billing_month_check', sql`${table.billingMonth} between 1 and 12`),
  ],
);
