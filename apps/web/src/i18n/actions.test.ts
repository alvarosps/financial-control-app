import { beforeEach, describe, expect, it, vi } from 'vitest';
import { setLocale } from './actions';
import { isLocale, type Locale, localeCookieName } from './config';

const { set } = vi.hoisted(() => ({ set: vi.fn() }));
vi.mock('next/headers', () => ({ cookies: async () => ({ set }) }));

describe('language preference', () => {
  beforeEach(() => set.mockClear());

  it('persists an English preference across routes for one year', async () => {
    await setLocale('en');
    expect(set).toHaveBeenCalledWith(
      localeCookieName,
      'en',
      expect.objectContaining({
        path: '/',
        maxAge: 31536000,
        httpOnly: true,
        sameSite: 'lax',
      }),
    );
  });

  it('rejects an untrusted locale before writing a cookie', async () => {
    for (const value of ['../../secret', 'EN', '', null]) expect(isLocale(value)).toBe(false);
    await expect(setLocale('../../secret' as Locale)).rejects.toThrow('UNSUPPORTED_LOCALE');
    expect(set).not.toHaveBeenCalled();
  });
});
