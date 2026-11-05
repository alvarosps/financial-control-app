import { DOMAIN_TYPES as DOMAIN_TYPE_LITERALS, type DomainType } from '@fc/shared';

export type { DomainType };

/**
 * Metadata (label + group) for every domain type. The object keys MUST be
 * exactly the literals declared in `@fc/shared` — the `satisfies
 * Record<DomainType, ...>` constraint enforces this at compile time, and
 * the runtime test in `domain-types.test.ts` double-checks parity.
 */
export const DOMAIN_TYPES = {
  // Credit Card
  credit_card_installment: { group: 'credit_card' as const, label: 'Parcela de cartão' },
  credit_card_fixed_charge: { group: 'credit_card' as const, label: 'Cobrança fixa' },
  credit_card_expense: { group: 'credit_card' as const, label: 'Despesa avulsa' },
  credit_card_annual_fee: { group: 'credit_card' as const, label: 'Anuidade' },
  credit_card_refund: { group: 'credit_card' as const, label: 'Reembolso' },
  bill_payment: { group: 'credit_card' as const, label: 'Pagamento de fatura' },

  // Loan
  loan_payment: { group: 'loan' as const, label: 'Parcela empréstimo' },
  loan_insurance: { group: 'loan' as const, label: 'Seguro empréstimo' },

  // Family Loan
  family_loan_installment: { group: 'family_loan' as const, label: 'Parcela cobrança' },
  family_loan_fixed_charge: { group: 'family_loan' as const, label: 'Cobrança fixa' },
  family_loan_expense: { group: 'family_loan' as const, label: 'Gasto único' },
  family_loan_discount: { group: 'family_loan' as const, label: 'Desconto' },
  family_loan_payment: { group: 'family_loan' as const, label: 'Pagamento recebido' },

  // Recurring
  recurring_bill: { group: 'recurring' as const, label: 'Conta recorrente' },

  // Income
  income_clt: { group: 'income' as const, label: 'Salário CLT' },
  income_pj: { group: 'income' as const, label: 'Receita PJ' },
  income_freelancer: { group: 'income' as const, label: 'Freelancer' },
  income_rental: { group: 'income' as const, label: 'Aluguel' },
  income_family_loan: { group: 'income' as const, label: 'Cobrança pessoal' },
  income_other: { group: 'income' as const, label: 'Renda extra' },
} as const satisfies Record<DomainType, { group: string; label: string }>;

export type DomainTypeGroup = (typeof DOMAIN_TYPES)[DomainType]['group'];

/**
 * Runtime list of domain-type keys — sourced from `@fc/shared` to remain the
 * single source of truth that feeds the Drizzle `domainTypeEnum`.
 */
export const DOMAIN_TYPE_VALUES: readonly DomainType[] = DOMAIN_TYPE_LITERALS;

export function getDomainTypeGroup(type: DomainType): DomainTypeGroup {
  return DOMAIN_TYPES[type].group;
}

export function getDomainTypesByGroup(group: DomainTypeGroup): DomainType[] {
  return DOMAIN_TYPE_VALUES.filter((t) => DOMAIN_TYPES[t].group === group);
}

export function isDomainType(value: string): value is DomainType {
  return value in DOMAIN_TYPES;
}
