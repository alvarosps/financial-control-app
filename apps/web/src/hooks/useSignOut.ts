'use client';

import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { useState } from 'react';
import { authClient } from '@/lib/auth-client';

export function useSignOut() {
  const t = useTranslations();
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [signingOut, setSigningOut] = useState(false);

  async function signOut() {
    setError(null);
    setSigningOut(true);
    try {
      const result = await authClient.signOut();
      if (result.error) {
        setError(result.error.message ?? t('auth.errors.signOutFailed'));
        setSigningOut(false);
      } else {
        router.push('/login');
      }
    } catch {
      setError(t('auth.errors.signOutFailed'));
      setSigningOut(false);
    }
  }

  return { signOut, signingOut, error };
}
