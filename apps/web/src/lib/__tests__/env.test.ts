import { describe, expect, it } from 'vitest';
import { strongSecret } from '../env';

describe('strongSecret', () => {
  it('rejects known placeholders regardless of casing or whitespace', () => {
    for (const v of [
      'your-secret-here',
      'YOUR-SECRET-HERE',
      '  your-secret-here  ',
      'change-me',
      'changeme',
      'CHANGE_ME',
      'replace-me',
      'secret',
      'password',
      'development',
      'placeholder',
    ]) {
      const r = strongSecret.safeParse(v);
      expect(r.success, `expected reject for ${JSON.stringify(v)}`).toBe(false);
    }
  });

  it('rejects secrets under 32 chars (after trim)', () => {
    expect(strongSecret.safeParse('a'.repeat(31)).success).toBe(false);
    expect(strongSecret.safeParse('   short   ').success).toBe(false);
  });

  it('rejects low-entropy 32-char strings (fewer than 8 distinct characters)', () => {
    expect(strongSecret.safeParse('x'.repeat(32)).success).toBe(false);
    expect(strongSecret.safeParse('ababab'.padEnd(32, 'a')).success).toBe(false);
  });

  it('accepts a real 32+ char high-entropy secret', () => {
    expect(strongSecret.safeParse('aZ9qL7vB2mR4tK6nP8xC3wS5yH0jF1dU').success).toBe(true);
  });
});
