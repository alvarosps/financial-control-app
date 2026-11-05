/**
 * useDraftMoney test (Task 10).
 *
 * The hook is pure React state + the canonical `toMoneyInputString` normalizer,
 * so it renders under `renderHook` with no providers. The normalized contract
 * mirrors the lib fn: Brazilian comma decimals and dot thousands separators are
 * coerced to the canonical "1234.56" form, and blank/non-numeric/non-positive
 * input yields `null` (invalid).
 */
import { act, renderHook } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { useDraftMoney } from './use-draft-money';

describe('useDraftMoney', () => {
  it('normalizes a plain integer to two decimals', () => {
    const { result } = renderHook(() => useDraftMoney('5000'));
    expect(result.current.isValid).toBe(true);
    expect(result.current.normalized).toBe('5000.00');
  });

  it('treats a comma as the decimal separator', () => {
    const { result } = renderHook(() => useDraftMoney('12,3'));
    expect(result.current.isValid).toBe(true);
    expect(result.current.normalized).toBe('12.30');
  });

  it('treats dots as thousands separators when a comma is present', () => {
    const { result } = renderHook(() => useDraftMoney('1.234,56'));
    expect(result.current.isValid).toBe(true);
    expect(result.current.normalized).toBe('1234.56');
  });

  it('is invalid for blank input', () => {
    const { result } = renderHook(() => useDraftMoney(''));
    expect(result.current.isValid).toBe(false);
    expect(result.current.normalized).toBeNull();
  });

  it('is invalid for non-numeric input', () => {
    const { result } = renderHook(() => useDraftMoney('abc'));
    expect(result.current.isValid).toBe(false);
    expect(result.current.normalized).toBeNull();
  });

  it('re-derives normalization when the value changes', () => {
    const { result } = renderHook(() => useDraftMoney(''));
    expect(result.current.isValid).toBe(false);

    act(() => result.current.setValue('5000'));
    expect(result.current.value).toBe('5000');
    expect(result.current.normalized).toBe('5000.00');
    expect(result.current.isValid).toBe(true);
  });
});
