import { expect } from 'vitest';

function errorChainText(error: unknown): string {
  const messages: string[] = [];
  const seen = new Set<object>();
  let current = error;

  while (typeof current === 'object' && current !== null && !seen.has(current)) {
    seen.add(current);
    const candidate = current as { cause?: unknown; constraint?: unknown; message?: unknown };

    if (typeof candidate.message === 'string') messages.push(candidate.message);
    if (typeof candidate.constraint === 'string') messages.push(candidate.constraint);

    current = candidate.cause;
  }

  return messages.join('\n');
}

export async function expectDbError(promise: PromiseLike<unknown>, pattern: RegExp): Promise<void> {
  let rejected = false;
  let error: unknown;

  try {
    await promise;
  } catch (caught) {
    rejected = true;
    error = caught;
  }

  expect(rejected).toBe(true);
  expect(errorChainText(error)).toMatch(pattern);
}
