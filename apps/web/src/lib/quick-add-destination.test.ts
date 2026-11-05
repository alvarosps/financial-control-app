import { beforeEach, describe, expect, it } from 'vitest';
import {
  destinationToValue,
  readLastDestination,
  valueToDestination,
  writeLastDestination,
} from './quick-add-destination';

describe('quick-add destination', () => {
  beforeEach(() => localStorage.clear());

  it('round-trips wallet and card destinations', () => {
    expect(destinationToValue({ kind: 'wallet', walletId: 'w1' })).toBe('wallet:w1');
    expect(destinationToValue({ kind: 'card', cardId: 'c1' })).toBe('card:c1');
    expect(valueToDestination('wallet:w1')).toEqual({ kind: 'wallet', walletId: 'w1' });
    expect(valueToDestination('card:c1')).toEqual({ kind: 'card', cardId: 'c1' });
  });

  it('rejects malformed values and corrupted storage', () => {
    expect(valueToDestination('wallet:')).toBeNull();
    expect(valueToDestination('other:x')).toBeNull();
    expect(readLastDestination(localStorage)).toBeNull();
    localStorage.setItem('fc.quickAdd.lastDestination', '{invalid');
    expect(readLastDestination(localStorage)).toBeNull();
  });

  it('persists the last valid destination', () => {
    writeLastDestination(localStorage, { kind: 'card', cardId: 'c9' });
    expect(readLastDestination(localStorage)).toEqual({ kind: 'card', cardId: 'c9' });
  });
});
