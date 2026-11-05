import { describe, expect, it } from 'vitest';
import {
  DOMAIN_TYPE_VALUES,
  DOMAIN_TYPES,
  getDomainTypeGroup,
  getDomainTypesByGroup,
  isDomainType,
} from './domain-types.ts';

describe('DOMAIN_TYPES', () => {
  it('contains at least one domain type', () => {
    expect(DOMAIN_TYPE_VALUES.length).toBeGreaterThan(0);
  });

  it('DOMAIN_TYPE_VALUES matches DOMAIN_TYPES keys', () => {
    expect(DOMAIN_TYPE_VALUES).toEqual(Object.keys(DOMAIN_TYPES));
  });
});

describe('getDomainTypeGroup', () => {
  it('returns credit_card for credit card types', () => {
    expect(getDomainTypeGroup('credit_card_installment')).toBe('credit_card');
    expect(getDomainTypeGroup('bill_payment')).toBe('credit_card');
  });

  it('returns loan for loan types', () => {
    expect(getDomainTypeGroup('loan_payment')).toBe('loan');
    expect(getDomainTypeGroup('loan_insurance')).toBe('loan');
  });

  it('returns family_loan for family loan types', () => {
    expect(getDomainTypeGroup('family_loan_installment')).toBe('family_loan');
    expect(getDomainTypeGroup('family_loan_expense')).toBe('family_loan');
    expect(getDomainTypeGroup('family_loan_discount')).toBe('family_loan');
    expect(getDomainTypeGroup('family_loan_payment')).toBe('family_loan');
  });

  it('returns income for income types', () => {
    expect(getDomainTypeGroup('income_clt')).toBe('income');
    expect(getDomainTypeGroup('income_pj')).toBe('income');
    expect(getDomainTypeGroup('income_rental')).toBe('income');
  });

  it('returns recurring for recurring types', () => {
    expect(getDomainTypeGroup('recurring_bill')).toBe('recurring');
  });
});

describe('getDomainTypesByGroup', () => {
  it('returns all credit card types', () => {
    const types = getDomainTypesByGroup('credit_card');
    expect(types).toContain('credit_card_installment');
    expect(types).toContain('credit_card_fixed_charge');
    expect(types).toContain('credit_card_expense');
    expect(types).toContain('credit_card_annual_fee');
    expect(types).toContain('credit_card_refund');
    expect(types).toContain('bill_payment');
    expect(types).toHaveLength(6);
  });

  it('returns all income types', () => {
    const types = getDomainTypesByGroup('income');
    expect(types).toContain('income_clt');
    expect(types).toContain('income_pj');
    expect(types).toContain('income_freelancer');
    expect(types).toContain('income_rental');
    expect(types).toContain('income_family_loan');
    expect(types).toContain('income_other');
    expect(types).toHaveLength(6);
  });

  it('returns all family loan types', () => {
    const types = getDomainTypesByGroup('family_loan');
    expect(types).toContain('family_loan_installment');
    expect(types).toContain('family_loan_fixed_charge');
    expect(types).toContain('family_loan_expense');
    expect(types).toContain('family_loan_discount');
    expect(types).toContain('family_loan_payment');
    expect(types).toHaveLength(5);
  });
});

describe('isDomainType', () => {
  it('returns true for valid domain types', () => {
    expect(isDomainType('credit_card_installment')).toBe(true);
    expect(isDomainType('income_pj')).toBe(true);
    expect(isDomainType('family_loan_expense')).toBe(true);
    expect(isDomainType('family_loan_payment')).toBe(true);
    expect(isDomainType('credit_card_refund')).toBe(true);
  });

  it('returns false for invalid/old domain types', () => {
    expect(isDomainType('not_a_domain_type')).toBe(false);
    expect(isDomainType('income')).toBe(false);
    expect(isDomainType('')).toBe(false);
    expect(isDomainType('random_string')).toBe(false);
  });
});
