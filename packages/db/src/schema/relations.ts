import { relations } from 'drizzle-orm';
import { accountBalanceSnapshots } from './account-balance-snapshots.ts';
import { accountShares, accounts } from './accounts.ts';
import { auditLog } from './audit-log.ts';
import { categories } from './categories.ts';
import { creditCardBills } from './credit-card-bills.ts';
import { creditCardConfigs } from './credit-card-configs.ts';
import { borrowedCards, familyLoanConfigs } from './family-loan-configs.ts';
import { faturaMatchRules } from './fatura-match-rules.ts';
import { incomeSourceConfigs } from './income-source-configs.ts';
import { loanConfigs } from './loan-configs.ts';
import { monthClosings } from './month-closings.ts';
import { scheduledTransactions } from './scheduled-transactions.ts';
import { simulationScenarios } from './simulation-scenarios.ts';
import { transactions } from './transactions.ts';
import { userProfiles } from './users.ts';

export const userProfilesRelations = relations(userProfiles, ({ many }) => ({
  accounts: many(accounts),
  transactions: many(transactions),
  categories: many(categories),
  monthClosings: many(monthClosings),
  faturaMatchRules: many(faturaMatchRules),
}));

export const monthClosingsRelations = relations(monthClosings, ({ one }) => ({
  user: one(userProfiles, { fields: [monthClosings.userId], references: [userProfiles.id] }),
}));

export const accountsRelations = relations(accounts, ({ one, many }) => ({
  user: one(userProfiles, { fields: [accounts.userId], references: [userProfiles.id] }),
  parentAccount: one(accounts, {
    fields: [accounts.parentAccountId],
    references: [accounts.id],
    relationName: 'additionalCards',
  }),
  additionalCards: many(accounts, { relationName: 'additionalCards' }),
  outgoingTransactions: many(transactions, { relationName: 'sourceTransactions' }),
  incomingTransactions: many(transactions, { relationName: 'destTransactions' }),
  shares: many(accountShares),
  creditCardConfig: one(creditCardConfigs, {
    fields: [accounts.id],
    references: [creditCardConfigs.accountId],
  }),
  loanConfig: one(loanConfigs, {
    fields: [accounts.id],
    references: [loanConfigs.accountId],
  }),
  incomeSourceConfig: one(incomeSourceConfigs, {
    fields: [accounts.id],
    references: [incomeSourceConfigs.accountId],
  }),
  familyLoanConfig: one(familyLoanConfigs, {
    fields: [accounts.id],
    references: [familyLoanConfigs.accountId],
  }),
}));

export const accountSharesRelations = relations(accountShares, ({ one }) => ({
  account: one(accounts, { fields: [accountShares.accountId], references: [accounts.id] }),
  sharedWithUser: one(userProfiles, {
    fields: [accountShares.sharedWithUserId],
    references: [userProfiles.id],
  }),
}));

export const transactionsRelations = relations(transactions, ({ one }) => ({
  user: one(userProfiles, { fields: [transactions.userId], references: [userProfiles.id] }),
  sourceAccount: one(accounts, {
    fields: [transactions.sourceAccountId],
    references: [accounts.id],
    relationName: 'sourceTransactions',
  }),
  destinationAccount: one(accounts, {
    fields: [transactions.destinationAccountId],
    references: [accounts.id],
    relationName: 'destTransactions',
  }),
  category: one(categories, { fields: [transactions.categoryId], references: [categories.id] }),
  paidFromAccount: one(accounts, {
    fields: [transactions.paidFromAccountId],
    references: [accounts.id],
  }),
  reversedBy: one(transactions, {
    fields: [transactions.reversedByTransactionId],
    references: [transactions.id],
    relationName: 'reversalOf',
  }),
  reverses: one(transactions, {
    fields: [transactions.reversesTransactionId],
    references: [transactions.id],
    relationName: 'reversedBy',
  }),
  scheduledTransaction: one(scheduledTransactions, {
    fields: [transactions.scheduledTransactionId],
    references: [scheduledTransactions.id],
  }),
}));

export const categoriesRelations = relations(categories, ({ one, many }) => ({
  user: one(userProfiles, { fields: [categories.userId], references: [userProfiles.id] }),
  parent: one(categories, {
    fields: [categories.parentId],
    references: [categories.id],
    relationName: 'subcategories',
  }),
  subcategories: many(categories, { relationName: 'subcategories' }),
  transactions: many(transactions),
}));

export const scheduledTransactionsRelations = relations(scheduledTransactions, ({ one, many }) => ({
  user: one(userProfiles, {
    fields: [scheduledTransactions.userId],
    references: [userProfiles.id],
  }),
  sourceAccount: one(accounts, {
    fields: [scheduledTransactions.sourceAccountId],
    references: [accounts.id],
  }),
  destinationAccount: one(accounts, {
    fields: [scheduledTransactions.destinationAccountId],
    references: [accounts.id],
  }),
  category: one(categories, {
    fields: [scheduledTransactions.categoryId],
    references: [categories.id],
  }),
  transactions: many(transactions),
  faturaMatchRules: many(faturaMatchRules),
}));

export const faturaMatchRulesRelations = relations(faturaMatchRules, ({ one }) => ({
  user: one(userProfiles, {
    fields: [faturaMatchRules.userId],
    references: [userProfiles.id],
  }),
  cardAccount: one(accounts, {
    fields: [faturaMatchRules.cardAccountId],
    references: [accounts.id],
  }),
  targetSchedule: one(scheduledTransactions, {
    fields: [faturaMatchRules.targetScheduleId],
    references: [scheduledTransactions.id],
  }),
}));

export const creditCardConfigsRelations = relations(creditCardConfigs, ({ one }) => ({
  account: one(accounts, { fields: [creditCardConfigs.accountId], references: [accounts.id] }),
}));

export const loanConfigsRelations = relations(loanConfigs, ({ one }) => ({
  account: one(accounts, { fields: [loanConfigs.accountId], references: [accounts.id] }),
}));

export const incomeSourceConfigsRelations = relations(incomeSourceConfigs, ({ one }) => ({
  account: one(accounts, { fields: [incomeSourceConfigs.accountId], references: [accounts.id] }),
}));

export const familyLoanConfigsRelations = relations(familyLoanConfigs, ({ one, many }) => ({
  account: one(accounts, { fields: [familyLoanConfigs.accountId], references: [accounts.id] }),
  borrowedCards: many(borrowedCards),
}));

export const borrowedCardsRelations = relations(borrowedCards, ({ one }) => ({
  familyLoanConfig: one(familyLoanConfigs, {
    fields: [borrowedCards.familyLoanConfigId],
    references: [familyLoanConfigs.id],
  }),
  creditCardAccount: one(accounts, {
    fields: [borrowedCards.creditCardAccountId],
    references: [accounts.id],
  }),
}));

export const creditCardBillsRelations = relations(creditCardBills, ({ one }) => ({
  creditCardAccount: one(accounts, {
    fields: [creditCardBills.creditCardAccountId],
    references: [accounts.id],
  }),
}));

export const accountBalanceSnapshotsRelations = relations(accountBalanceSnapshots, ({ one }) => ({
  account: one(accounts, {
    fields: [accountBalanceSnapshots.accountId],
    references: [accounts.id],
  }),
}));

export const auditLogRelations = relations(auditLog, ({ one }) => ({
  user: one(userProfiles, { fields: [auditLog.userId], references: [userProfiles.id] }),
}));

export const simulationScenariosRelations = relations(simulationScenarios, ({ one }) => ({
  user: one(userProfiles, { fields: [simulationScenarios.userId], references: [userProfiles.id] }),
}));
