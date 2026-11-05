'use client';

import { Copy, Loader2, Upload } from 'lucide-react';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { type FormEvent, useRef, useState } from 'react';
import { toast } from 'sonner';
import { ErrorAlert } from '@/components/shared/ErrorAlert';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Textarea } from '@/components/ui/textarea';
import { trpc } from '@/lib/trpc/client';
import { resolveTRPCError } from '@/lib/trpc-errors';

const MAX_BYTES = 3 * 1024 * 1024;
const NS = 'components-credit-cards-import-importfaturadialog';

type ImportMode = 'automatic' | 'manual';
type ManualProvider = 'claude' | 'chatgpt' | 'other';

function isImportMode(value: string): value is ImportMode {
  return value === 'automatic' || value === 'manual';
}

function isManualProvider(value: string | null): value is ManualProvider {
  return value === 'claude' || value === 'chatgpt' || value === 'other';
}

function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = String(reader.result ?? '');
      const separator = result.indexOf(',');
      resolve(separator >= 0 ? result.slice(separator + 1) : result);
    };
    reader.onerror = () => reject(reader.error ?? new Error('Falha ao ler arquivo'));
    reader.readAsDataURL(file);
  });
}

type Props = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  cardId: string;
  hasProfile: boolean;
  onDraftCreated: (importId: string) => void;
  cardName?: string;
  profileSetupHref?: string;
  isLoading?: boolean;
  loadError?: string;
  onRetry?: () => void;
  finalFocus?: () => HTMLElement | null;
};

export function ImportFaturaDialog({
  open,
  onOpenChange,
  cardId,
  hasProfile,
  onDraftCreated,
  cardName,
  profileSetupHref,
  isLoading = false,
  loadError,
  onRetry,
  finalFocus,
}: Props) {
  const t = useTranslations();
  const [mode, setMode] = useState<ImportMode>('automatic');
  const utils = trpc.useUtils();
  const capabilities = trpc.faturaImport.capabilities.useQuery(undefined, { enabled: open });
  const drafts = trpc.faturaImport.listByCard.useQuery(
    { cardAccountId: cardId },
    { enabled: open },
  );
  const effectiveMode =
    mode === 'automatic' && capabilities.data?.available === false ? 'manual' : mode;
  const [period, setPeriod] = useState('');
  const [consent, setConsent] = useState(false);
  const activeUpload = useRef<AbortController | null>(null);
  const [file, setFile] = useState<File | null>(null);
  const [provider, setProvider] = useState<ManualProvider>('claude');
  const [responseJson, setResponseJson] = useState('');
  const [readingFile, setReadingFile] = useState(false);
  const submitting = useRef(false);
  const manualPrompt = trpc.faturaImport.manualPrompt.useQuery(
    { cardAccountId: cardId },
    { enabled: open && effectiveMode === 'manual' && hasProfile },
  );

  function draftCreated(draft: { id: string }) {
    setFile(null);
    setResponseJson('');
    onOpenChange(false);
    onDraftCreated(draft.id);
  }

  const uploadManual = trpc.faturaImport.uploadManual.useMutation({
    onSuccess: draftCreated,
    onError: (error) => toast.error(resolveTRPCError(error, t)),
    onSettled: () => {
      submitting.current = false;
    },
  });
  const isPending = readingFile || uploadManual.isPending;
  const selectedPeriod = /^\d{4}-\d{2}$/.test(period)
    ? { year: Number(period.slice(0, 4)), month: Number(period.slice(5, 7)) }
    : undefined;
  const canSubmit =
    Boolean(selectedPeriod) &&
    hasProfile &&
    !isLoading &&
    !loadError &&
    !isPending &&
    !submitting.current;

  async function submitAutomatic(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (file === null || !canSubmit || !consent || !capabilities.data?.available) return;
    if (file.type !== 'application/pdf') {
      toast.error(t(`${NS}.invalidFile`));
      return;
    }
    if (file.size > MAX_BYTES) {
      toast.error(t(`${NS}.fileTooLarge`));
      return;
    }
    submitting.current = true;
    setReadingFile(true);
    const controller = new AbortController();
    activeUpload.current = controller;
    try {
      const pdfBase64 = await fileToBase64(file);
      if (controller.signal.aborted) return;
      const draft = await utils.client.faturaImport.upload.mutate(
        {
          cardAccountId: cardId,
          fileName: file.name,
          pdfBase64,
          externalConsent: true,
          selectedPeriod,
        },
        { signal: controller.signal },
      );
      if (!controller.signal.aborted) draftCreated(draft);
    } catch (error) {
      if (!controller.signal.aborted) toast.error(resolveTRPCError(error, t));
    } finally {
      submitting.current = false;
      activeUpload.current = null;
      setReadingFile(false);
    }
  }

  function submitManual(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (responseJson.trim().length === 0 || !canSubmit) return;
    submitting.current = true;
    uploadManual.mutate({ cardAccountId: cardId, provider, responseJson, selectedPeriod });
  }

  async function copyPrompt() {
    const prompt = manualPrompt.data?.prompt;
    if (prompt === undefined) return;
    try {
      await navigator.clipboard.writeText(prompt);
      toast.success(t(`${NS}.promptCopied`));
    } catch {
      toast.error(t(`${NS}.copyFailed`));
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(nextOpen) => {
        if (!isPending && !submitting.current) onOpenChange(nextOpen);
      }}
    >
      <DialogContent
        className="w-[calc(100vw-1rem)] max-h-[calc(100dvh-1rem)] overflow-y-auto overflow-x-hidden sm:max-w-lg"
        finalFocus={finalFocus}
        showCloseButton={!isPending}
      >
        <DialogHeader>
          <DialogTitle>{t(`${NS}.title`)}</DialogTitle>
          {cardName && <DialogDescription>{cardName}</DialogDescription>}
        </DialogHeader>
        {isLoading ? (
          <p role="status">{t('common.loading')}</p>
        ) : loadError ? (
          <ErrorAlert message={loadError} onRetry={onRetry} />
        ) : (
          <>
            {!hasProfile && profileSetupHref && (
              <Link href={profileSetupHref} className="text-sm underline underline-offset-4">
                {t('creditCards.import.configureProfile')}
              </Link>
            )}
            <div className="space-y-2 min-w-0">
              <Label htmlFor="statement-period">{t('statement.selectPeriod')}</Label>
              <Input
                id="statement-period"
                type="month"
                min="1000-01"
                max="9998-12"
                value={period}
                disabled={isPending}
                onChange={(event) => setPeriod(event.target.value)}
              />
              <p className="text-xs text-muted-foreground">{t('statement.periodHint')}</p>
            </div>
            {capabilities.data?.available === false && (
              <p role="status" className="text-sm text-muted-foreground">
                {t('statement.parserUnavailable')}
              </p>
            )}
            {capabilities.isError && (
              <ErrorAlert
                message={t('statement.capabilitiesFailed')}
                onRetry={() => void capabilities.refetch()}
              />
            )}
            {(drafts.data ?? [])
              .filter((draft) => draft.status === 'draft')
              .map((draft) => (
                <Button
                  key={draft.id}
                  variant="outline"
                  className="h-auto whitespace-normal break-all"
                  disabled={isPending}
                  onClick={() => {
                    onOpenChange(false);
                    onDraftCreated(draft.id);
                  }}
                >
                  {t('statement.resumeDraft', {
                    file: draft.fileName ?? 'JSON',
                    period: `${draft.billingMonth}/${draft.billingYear}`,
                  })}
                </Button>
              ))}
            <Tabs
              value={effectiveMode}
              onValueChange={(value) => {
                if (!isPending && isImportMode(value)) setMode(value);
              }}
            >
              <TabsList className="w-full">
                <TabsTrigger
                  value="automatic"
                  disabled={isPending || capabilities.data?.available !== true}
                >
                  {t(`${NS}.automaticTab`)}
                </TabsTrigger>
                <TabsTrigger value="manual" disabled={isPending}>
                  {t(`${NS}.manualTab`)}
                </TabsTrigger>
              </TabsList>

              <TabsContent value="automatic">
                <form className="space-y-4" onSubmit={submitAutomatic}>
                  <div className="space-y-2">
                    <Label htmlFor="fatura-pdf">{t(`${NS}.selectPdf`)}</Label>
                    <Input
                      id="fatura-pdf"
                      type="file"
                      accept="application/pdf"
                      disabled={isPending}
                      onChange={(event) => setFile(event.target.files?.[0] ?? null)}
                    />
                    <p className="text-xs text-muted-foreground">{t(`${NS}.hint`)}</p>
                    {!hasProfile ? (
                      <p className="text-xs text-amber-700 dark:text-amber-400">
                        {t(`${NS}.noProfile`)}
                      </p>
                    ) : null}
                  </div>
                  <p className="text-xs text-muted-foreground">{t('statement.externalNotice')}</p>
                  <a
                    href="https://platform.claude.com/docs/en/about-claude/pricing"
                    target="_blank"
                    rel="noreferrer"
                    className="text-sm underline"
                  >
                    {t('statement.pricing')}
                  </a>
                  <Label className="flex items-start gap-2 text-sm leading-5">
                    <input
                      type="checkbox"
                      className="size-4 shrink-0"
                      checked={consent}
                      onChange={(event) => setConsent(event.target.checked)}
                      disabled={isPending}
                    />
                    {t('statement.externalConsent')}
                  </Label>
                  <DialogFooter>
                    {readingFile && (
                      <Button
                        type="button"
                        variant="outline"
                        onClick={() => activeUpload.current?.abort()}
                      >
                        {t('common.cancel')}
                      </Button>
                    )}
                    <Button
                      type="submit"
                      disabled={
                        file === null ||
                        !canSubmit ||
                        !consent ||
                        capabilities.data?.available !== true
                      }
                    >
                      {isPending ? (
                        <>
                          <Loader2 className="mr-2 size-4 animate-spin" />
                          {t(`${NS}.parsing`)}
                        </>
                      ) : (
                        <>
                          <Upload className="mr-2 size-4" />
                          {t(`${NS}.import`)}
                        </>
                      )}
                    </Button>
                  </DialogFooter>
                </form>
              </TabsContent>

              <TabsContent value="manual">
                <form className="space-y-4" onSubmit={submitManual}>
                  <p className="text-xs text-muted-foreground">{t(`${NS}.manualIntro`)}</p>
                  {!hasProfile ? (
                    <p className="text-xs text-amber-700 dark:text-amber-400">
                      {t(`${NS}.noProfile`)}
                    </p>
                  ) : null}
                  <div className="space-y-2">
                    <Label htmlFor="fatura-manual-prompt">{t(`${NS}.promptLabel`)}</Label>
                    <Textarea
                      id="fatura-manual-prompt"
                      className="h-32 resize-none font-mono text-xs"
                      readOnly
                      value={
                        manualPrompt.data?.prompt ??
                        (manualPrompt.isError ? t(`${NS}.promptFailed`) : t(`${NS}.promptLoading`))
                      }
                    />
                    <Button
                      type="button"
                      variant="outline"
                      disabled={manualPrompt.data === undefined}
                      onClick={copyPrompt}
                    >
                      <Copy className="mr-2 size-4" />
                      {t(`${NS}.copyPrompt`)}
                    </Button>
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="fatura-manual-provider">{t(`${NS}.providerLabel`)}</Label>
                    <Select
                      value={provider}
                      disabled={isPending}
                      onValueChange={(value) => {
                        if (isManualProvider(value)) setProvider(value);
                      }}
                    >
                      <SelectTrigger id="fatura-manual-provider">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="claude">{t(`${NS}.providerClaude`)}</SelectItem>
                        <SelectItem value="chatgpt">{t(`${NS}.providerChatgpt`)}</SelectItem>
                        <SelectItem value="other">{t(`${NS}.providerOther`)}</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="fatura-manual-response">{t(`${NS}.responseLabel`)}</Label>
                    <Textarea
                      id="fatura-manual-response"
                      className="h-40 font-mono text-xs"
                      placeholder={t(`${NS}.responsePlaceholder`)}
                      value={responseJson}
                      disabled={isPending}
                      onChange={(event) => setResponseJson(event.target.value)}
                    />
                  </div>
                  <DialogFooter>
                    <Button type="submit" disabled={!canSubmit || responseJson.trim().length === 0}>
                      {uploadManual.isPending ? (
                        <>
                          <Loader2 className="mr-2 size-4 animate-spin" />
                          {t(`${NS}.manualSubmitting`)}
                        </>
                      ) : (
                        t(`${NS}.manualImport`)
                      )}
                    </Button>
                  </DialogFooter>
                </form>
              </TabsContent>
            </Tabs>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}
