import { useState } from 'react';
import { toMoneyInputString } from '@/lib/money';

/**
 * Draft-string money input pattern shared by the lever editors.
 *
 * Holds the raw user input as free-form text (`value`) and derives the
 * canonical money string the API expects via {@link toMoneyInputString}
 * (`normalized`). `normalized` is `null` — and `isValid` therefore `false` —
 * whenever the input is blank, non-numeric, or non-positive, so callers never
 * send NaN/zero/negative amounts to the server. The normalization is delegated
 * entirely to the canonical lib fn; this hook does not reimplement parsing.
 */
export function useDraftMoney(initial: string): {
  value: string;
  setValue: (v: string) => void;
  normalized: string | null;
  isValid: boolean;
} {
  const [value, setValue] = useState(initial);
  const normalized = toMoneyInputString(value);
  return { value, setValue, normalized, isValid: normalized !== null };
}
