'use client';
import { useTranslations } from 'next-intl';
import { useEffect, useState } from 'react';
import { ErrorAlert } from '@/components/shared/ErrorAlert';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { trpc } from '@/lib/trpc/client';

export function CaptureDevicesSettings() {
  const t = useTranslations('captureDevices');
  const utils = trpc.useUtils();
  const query = trpc.captureDevice.list.useQuery();
  const [name, setName] = useState('');
  const [code, setCode] = useState<{ code: string; expiresAt: Date } | null>(null);
  const [copied, setCopied] = useState(false);
  const [copyFailed, setCopyFailed] = useState(false);
  const pairing = trpc.captureDevice.createPairing.useMutation({
    onSuccess: (value) => {
      setCode(value);
      setCopied(false);
      setCopyFailed(false);
    },
  });
  const revoke = trpc.captureDevice.revoke.useMutation({
    onSuccess: () => {
      setCode(null);
      void utils.captureDevice.list.invalidate();
    },
  });
  useEffect(() => {
    if (!code) return;
    const timer = window.setTimeout(
      () => setCode(null),
      Math.max(0, new Date(code.expiresAt).getTime() - Date.now()),
    );
    return () => window.clearTimeout(timer);
  }, [code]);
  const error = query.error ?? pairing.error ?? revoke.error;
  return (
    <Card surface="solid">
      <CardContent className="space-y-4">
        <h2 className="font-heading text-base font-medium">{t('title')}</h2>
        <p className="text-sm text-muted-foreground">{t('description')}</p>
        {error && <ErrorAlert message={error.message} />}
        {query.data && !query.data.enabled && <p className="text-sm">{t('disabled')}</p>}
        {query.data?.enabled && (
          <form
            className="space-y-2"
            onSubmit={(event) => {
              event.preventDefault();
              setCode(null);
              pairing.mutate({ name: name.trim() });
            }}
          >
            <Label htmlFor="capture-device-name">{t('name')}</Label>
            <div className="flex flex-wrap gap-2">
              <Input
                id="capture-device-name"
                maxLength={80}
                value={name}
                onChange={(e) => setName(e.target.value)}
                className="max-w-sm"
                required
              />
              <Button type="submit" disabled={pairing.isPending || !name.trim()}>
                {t('pair')}
              </Button>
            </div>
          </form>
        )}
        {code && (
          <div role="status" className="space-y-2 rounded-lg border p-3">
            <p className="text-sm">{t('codeHelp')}</p>
            <code className="block break-all select-all text-sm">{code.code}</code>
            <Button
              variant="outline"
              onClick={async () => {
                try {
                  await navigator.clipboard.writeText(code.code);
                  setCopied(true);
                  setCopyFailed(false);
                } catch {
                  setCopyFailed(true);
                }
              }}
            >
              {copied ? t('copied') : t('copy')}
            </Button>
            {copyFailed && <p className="text-sm">{t('copyFailed')}</p>}
          </div>
        )}
        <ul className="space-y-3">
          {query.data?.devices.map((device) => (
            <li key={device.id} className="rounded-lg border p-3 space-y-2">
              <div className="font-medium">{device.name}</div>
              <p className="text-sm text-muted-foreground">
                {device.revokedAt
                  ? t('revoked')
                  : new Date(device.expiresAt) <= new Date()
                    ? t('expired')
                    : t('active')}
              </p>
              <p className="text-sm">
                {t('lastDelivery')}:{' '}
                {device.lastReceivedAt
                  ? new Date(device.lastReceivedAt).toLocaleString()
                  : t('none')}
              </p>
              <div className="flex flex-wrap gap-2">
                {query.data?.enabled && (
                  <Button
                    variant="outline"
                    disabled={pairing.isPending}
                    onClick={() => {
                      setCode(null);
                      pairing.mutate({ name: device.name, deviceId: device.id });
                    }}
                  >
                    {t('repair')}
                  </Button>
                )}
                {!device.revokedAt && (
                  <Button
                    variant="destructive"
                    disabled={revoke.isPending}
                    onClick={() => revoke.mutate({ deviceId: device.id })}
                  >
                    {t('revoke')}
                  </Button>
                )}
              </div>
            </li>
          ))}
        </ul>
      </CardContent>
    </Card>
  );
}
