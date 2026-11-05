'use client';

import { LogOut, Settings } from 'lucide-react';
import { useLocale, useTranslations } from 'next-intl';
import { FinancialAlerts } from '@/components/alerts/FinancialAlerts';
import { IntegrationSettings } from '@/components/integrations/ConnectionCard';
import { ErrorAlert } from '@/components/shared/ErrorAlert';
import { PageHeader } from '@/components/shared/PageHeader';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { usePageTitle } from '@/hooks/usePageTitle';
import { useSignOut } from '@/hooks/useSignOut';
import { trpc } from '@/lib/trpc/client';
import { CaptureDevicesSettings } from './CaptureDevicesSettings';

function getInitials(name?: string | null): string {
  if (!name) return '?';
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return '?';
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

export function SettingsClient() {
  const locale = useLocale();
  const t = useTranslations();
  usePageTitle(t('pageTitles.settings'));
  const { data: profile, isLoading, error, refetch } = trpc.dashboard.profile.useQuery();
  const { signOut, signingOut, error: signOutError } = useSignOut();

  const memberSince = profile?.createdAt
    ? new Intl.DateTimeFormat(locale, { month: 'long', year: 'numeric', timeZone: 'UTC' }).format(
        new Date(profile.createdAt),
      )
    : null;

  return (
    <div className="space-y-6">
      <PageHeader
        title={t('settings.title')}
        subtitle={t('settings.subtitle')}
        actions={
          <span className="grid size-10 place-items-center rounded-lg bg-primary/15 text-primary">
            <Settings className="size-5" />
          </span>
        }
      />

      {error && <ErrorAlert message={error.message} onRetry={() => void refetch()} />}
      {signOutError && <ErrorAlert message={signOutError} />}

      <Card surface="solid">
        <CardContent className="space-y-6">
          <div className="flex items-start justify-between gap-4">
            <div className="flex items-center gap-4">
              <div className="grid size-14 shrink-0 place-items-center rounded-2xl gradient-brand text-lg font-bold text-white">
                {isLoading ? (
                  <Skeleton className="size-6 rounded-md" />
                ) : (
                  getInitials(profile?.name)
                )}
              </div>
              <div className="min-w-0">
                <h2 className="text-lg font-semibold">{t('settings.profileTitle')}</h2>
                {isLoading ? (
                  <Skeleton className="mt-1 h-4 w-40" />
                ) : (
                  <p className="truncate text-sm text-muted-foreground">{profile?.email ?? '--'}</p>
                )}
              </div>
            </div>
            <Button
              type="button"
              variant="destructive"
              onClick={() => void signOut()}
              disabled={signingOut}
            >
              <LogOut />
              {signingOut ? t('auth.signingOut') : t('auth.signOutAction')}
            </Button>
          </div>

          <dl className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <div className="space-y-1">
              <dt className="text-sm text-muted-foreground">{t('settings.name')}</dt>
              {isLoading ? (
                <Skeleton className="h-5 w-48" />
              ) : (
                <dd className="font-medium">{profile?.name ?? '--'}</dd>
              )}
            </div>

            <div className="space-y-1">
              <dt className="text-sm text-muted-foreground">{t('settings.email')}</dt>
              {isLoading ? (
                <Skeleton className="h-5 w-64" />
              ) : (
                <dd className="font-medium">{profile?.email ?? '--'}</dd>
              )}
            </div>

            {(isLoading || memberSince) && (
              <div className="space-y-1">
                <dt className="text-sm text-muted-foreground">{t('settings.memberSince')}</dt>
                {isLoading ? (
                  <Skeleton className="h-5 w-32" />
                ) : (
                  <dd className="font-medium capitalize">{memberSince}</dd>
                )}
              </div>
            )}
          </dl>
        </CardContent>
      </Card>
      <CaptureDevicesSettings />
      <IntegrationSettings />
      <FinancialAlerts showHistory />
    </div>
  );
}
