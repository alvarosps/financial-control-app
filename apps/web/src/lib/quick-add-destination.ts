export type QuickAddDestination =
  | { kind: 'wallet'; walletId: string }
  | { kind: 'card'; cardId: string };

const storageKey = 'fc.quickAdd.lastDestination';

export function destinationToValue(destination: QuickAddDestination): string {
  return destination.kind === 'wallet'
    ? `wallet:${destination.walletId}`
    : `card:${destination.cardId}`;
}

export function valueToDestination(value: string): QuickAddDestination | null {
  const [kind, id, ...rest] = value.split(':');
  if (rest.length > 0 || !id) return null;
  if (kind === 'wallet') return { kind, walletId: id };
  if (kind === 'card') return { kind, cardId: id };
  return null;
}

export function readLastDestination(storage: Pick<Storage, 'getItem'>): QuickAddDestination | null {
  const value = storage.getItem(storageKey);
  if (!value) return null;
  try {
    const parsed: unknown = JSON.parse(value);
    if (
      typeof parsed === 'object' &&
      parsed !== null &&
      'kind' in parsed &&
      'walletId' in parsed &&
      parsed.kind === 'wallet' &&
      typeof parsed.walletId === 'string' &&
      parsed.walletId
    ) {
      return { kind: 'wallet', walletId: parsed.walletId };
    }
    if (
      typeof parsed === 'object' &&
      parsed !== null &&
      'kind' in parsed &&
      'cardId' in parsed &&
      parsed.kind === 'card' &&
      typeof parsed.cardId === 'string' &&
      parsed.cardId
    ) {
      return { kind: 'card', cardId: parsed.cardId };
    }
  } catch {
    return null;
  }
  return null;
}

export function writeLastDestination(
  storage: Pick<Storage, 'setItem'>,
  destination: QuickAddDestination,
): void {
  storage.setItem(storageKey, JSON.stringify(destination));
}
