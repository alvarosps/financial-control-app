import { describe, expect, it } from 'vitest';

import { operationErrorCode, startOperationTimer } from './operation-timer.ts';

describe('startOperationTimer', () => {
  it('returns a stable duration rounded to two decimals', () => {
    const readings = [100, 123.456];
    const timer = startOperationTimer(() => readings.shift() ?? 123.456);

    expect(timer.elapsedMs()).toBe(23.46);
  });

  it('uses a stable error code without exposing an error message', () => {
    expect(operationErrorCode({ code: 'BAD_REQUEST', message: 'private description' })).toBe(
      'BAD_REQUEST',
    );
    expect(operationErrorCode(new Error('private description'))).toBe('Error');
  });
});
