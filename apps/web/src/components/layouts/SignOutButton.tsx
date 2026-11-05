'use client';

import { LogOut } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { Button } from '@/components/ui/button';
import { Tooltip } from '@/components/ui/tooltip';
import { useSignOut } from '@/hooks/useSignOut';

export function SignOutButton() {
  const t = useTranslations();
  const { signOut, signingOut } = useSignOut();
  const label = signingOut ? t('auth.signingOut') : t('auth.signOutAction');

  return (
    <Tooltip content={label}>
      <Button
        type="button"
        variant="ghost"
        size="icon"
        onClick={() => void signOut()}
        disabled={signingOut}
        aria-label={label}
      >
        <LogOut />
      </Button>
    </Tooltip>
  );
}
