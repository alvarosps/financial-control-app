'use server';

import { cookies } from 'next/headers';
import { isLocale, type Locale, localeCookieName } from './config';

export async function setLocale(locale: Locale): Promise<void> {
  if (!isLocale(locale)) throw new Error('UNSUPPORTED_LOCALE');
  (await cookies()).set(localeCookieName, locale, {
    path: '/',
    maxAge: 60 * 60 * 24 * 365,
    sameSite: 'lax',
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
  });
}
