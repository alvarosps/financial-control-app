import { describe, expect, it } from 'vitest';
import { isWithinDays } from '@/lib/dates';

function inDeviceTimeZone<T>(timeZone: string, callback: () => T): T {
  const previous = process.env.TZ;
  try {
    process.env.TZ = timeZone;
    return callback();
  } finally {
    if (previous === undefined) {
      delete process.env.TZ;
    } else {
      process.env.TZ = previous;
    }
  }
}

describe('isWithinDays', () => {
  // Keep the reference inside 4 July in America/Sao_Paulo. A local-midnight
  // constructor becomes 3 July for the CI runner's UTC clock.
  const now = new Date('2026-07-04T12:00:00-03:00');

  it('includes today and the boundary day', () => {
    expect(isWithinDays('2026-07-04', 7, now)).toBe(true);
    expect(isWithinDays('2026-07-11', 7, now)).toBe(true);
  });

  it('excludes past dates and dates beyond the window', () => {
    expect(isWithinDays('2026-07-03', 7, now)).toBe(false);
    expect(isWithinDays('2026-07-12', 7, now)).toBe(false);
  });

  it('returns false for malformed input', () => {
    expect(isWithinDays('not-a-date', 7, now)).toBe(false);
    expect(isWithinDays('2026-02-30', 7, now)).toBe(false);
  });

  it('uses the Sao Paulo day when the device is still on the previous UTC-7 day', () => {
    inDeviceTimeZone('Etc/GMT+7', () => {
      expect(isWithinDays('2026-07-05', 0, new Date('2026-07-05T03:30:00Z'))).toBe(true);
    });
  });

  it('keeps civil-day boundaries at the Sao Paulo DST transition', () => {
    inDeviceTimeZone('America/Sao_Paulo', () => {
      const afterSpringForward = new Date('2018-11-04T03:30:00Z');

      expect(isWithinDays('2018-11-04', 0, afterSpringForward)).toBe(true);
      expect(isWithinDays('2018-11-03', 0, afterSpringForward)).toBe(false);
    });
  });
});
