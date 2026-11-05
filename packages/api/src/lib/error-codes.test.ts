import { describe, expect, it } from 'vitest';
import { ERROR_CODES, errorCause } from './error-codes.ts';

describe('errorCause', () => {
  it('returns a cause object with i18nKey and code', () => {
    expect(errorCause('rateLimited')).toEqual({
      i18nKey: 'errors.rateLimited',
      code: 'rateLimited',
    });
  });

  it('merges extras without overwriting i18nKey or code', () => {
    const result = errorCause('bill.alreadyPaid', { cardAccountId: 'abc' });
    expect(result).toMatchObject({
      i18nKey: 'errors.bill.alreadyPaid',
      code: 'bill.alreadyPaid',
      cardAccountId: 'abc',
    });
  });

  it('ignores attempts to override i18nKey or code via extras', () => {
    const result = errorCause('bill.alreadyPaid', {
      i18nKey: 'errors.ignored',
      code: 'ignored',
      cardAccountId: 'abc',
    });
    expect(result.i18nKey).toBe('errors.bill.alreadyPaid');
    expect(result.code).toBe('bill.alreadyPaid');
    expect(result.cardAccountId).toBe('abc');
  });

  it('covers every ERROR_CODES entry', () => {
    for (const code of ERROR_CODES) {
      const cause = errorCause(code);
      expect(cause.i18nKey).toBe(`errors.${code}`);
      expect(cause.code).toBe(code);
    }
  });
});
