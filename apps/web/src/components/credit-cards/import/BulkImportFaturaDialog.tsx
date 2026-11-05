'use client';

import { Copy, Loader2 } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { useEffect, useMemo, useState } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import { trpc } from '@/lib/trpc/client';

const NS = 'components-credit-cards-import-bulkimportfaturadialog';
const MAX_CARDS = 20;

type ManualProvider = 'claude' | 'chatgpt' | 'other';
type Step = 'select' | 'extract' | 'result';

export type BulkImportCard = {
  id: string;
  name: string;
  profile: string | null;
};

type Draft = {
  importId: string;
  cardAccountId: string;
  cardName: string;
};

type Props = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  cards: BulkImportCard[];
  onDraftsReady: (drafts: Draft[]) => void;
};

function isManualProvider(value: string | null): value is ManualProvider {
  return value === 'claude' || value === 'chatgpt' || value === 'other';
}

export function BulkImportFaturaDialog({ open, onOpenChange, cards, onDraftsReady }: Props) {
  const t = useTranslations();
  const [step, setStep] = useState<Step>('select');
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [provider, setProvider] = useState<ManualProvider>('claude');
  const [responseJson, setResponseJson] = useState('');
  const [results, setResults] = useState<
    Array<{ cardName: string; status: 'draft' | 'error'; message?: string }>
  >([]);

  const selectedCards = useMemo(
    () => cards.filter((card) => selectedIds.includes(card.id)),
    [cards, selectedIds],
  );
  const prompt = trpc.faturaImport.bulkManualPrompt.useQuery(
    { cardAccountIds: selectedIds },
    { enabled: open && step === 'extract' && selectedIds.length > 0 },
  );

  const upload = trpc.faturaImport.uploadManualBulk.useMutation({
    onSuccess: (items) => {
      const drafts = items.flatMap((item) =>
        item.importId !== undefined
          ? [
              {
                importId: item.importId,
                cardAccountId: item.cardAccountId,
                cardName:
                  selectedCards.find((card) => card.id === item.cardAccountId)?.name ??
                  item.reference,
              },
            ]
          : [],
      );
      setResults(
        items.map((item) => ({
          cardName:
            selectedCards.find((card) => card.id === item.cardAccountId)?.name ?? item.reference,
          status: item.importId === undefined ? 'error' : 'draft',
          ...(item.importId === undefined ? { message: item.error } : {}),
        })),
      );
      if (drafts.length > 0) onDraftsReady(drafts);
      setStep('result');
    },
    onError: (error) => toast.error(error.message || t(`${NS}.submitFailed`)),
  });

  useEffect(() => {
    if (open) return;
    setStep('select');
    setSelectedIds([]);
    setResponseJson('');
    setResults([]);
  }, [open]);

  function toggleCard(cardId: string) {
    setSelectedIds((ids) =>
      ids.includes(cardId) ? ids.filter((id) => id !== cardId) : [...ids, cardId],
    );
  }

  function selectAll() {
    setSelectedIds(
      selectedIds.length === cards.length ? [] : cards.slice(0, MAX_CARDS).map((c) => c.id),
    );
  }

  async function copyPrompt() {
    if (prompt.data === undefined) return;
    try {
      await navigator.clipboard.writeText(prompt.data.prompt);
      toast.success(t(`${NS}.promptCopied`));
    } catch {
      toast.error(t(`${NS}.copyFailed`));
    }
  }

  function submit() {
    if (responseJson.trim().length === 0) return;
    upload.mutate({ cardAccountIds: selectedIds, provider, responseJson });
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>{t(`${NS}.title`)}</DialogTitle>
          <DialogDescription>{t(`${NS}.${step}Description`)}</DialogDescription>
        </DialogHeader>

        {step === 'select' ? (
          <div className="space-y-4">
            <div className="flex items-center justify-between gap-3">
              <span className="text-sm text-muted-foreground">
                {t(`${NS}.selectedCount`, { count: selectedIds.length, max: MAX_CARDS })}
              </span>
              <Button type="button" size="sm" variant="outline" onClick={selectAll}>
                {selectedIds.length === cards.length ? t(`${NS}.clearAll`) : t(`${NS}.selectAll`)}
              </Button>
            </div>
            <div className="max-h-72 space-y-2 overflow-y-auto">
              {cards.map((card) => (
                <label
                  key={card.id}
                  className="flex cursor-pointer items-center gap-3 rounded-md border p-3"
                >
                  <input
                    type="checkbox"
                    checked={selectedIds.includes(card.id)}
                    onChange={() => toggleCard(card.id)}
                  />
                  <span className="flex min-w-0 flex-1 flex-col">
                    <span className="font-medium">{card.name}</span>
                    <span className="text-xs text-muted-foreground">
                      {card.profile ?? t(`${NS}.profileMissing`)}
                    </span>
                  </span>
                </label>
              ))}
            </div>
          </div>
        ) : null}

        {step === 'extract' ? (
          <div className="space-y-4">
            <p className="text-xs text-muted-foreground">{t(`${NS}.attachPdfs`)}</p>
            <div className="space-y-2">
              <Label htmlFor="bulk-fatura-prompt">{t(`${NS}.promptLabel`)}</Label>
              <Textarea
                id="bulk-fatura-prompt"
                className="h-32 resize-none font-mono text-xs"
                readOnly
                value={
                  prompt.data?.prompt ??
                  (prompt.isError ? t(`${NS}.promptFailed`) : t(`${NS}.promptLoading`))
                }
              />
              <Button type="button" variant="outline" disabled={!prompt.data} onClick={copyPrompt}>
                <Copy className="mr-2 size-4" />
                {t(`${NS}.copyPrompt`)}
              </Button>
            </div>
            <div className="space-y-2">
              <Label htmlFor="bulk-fatura-provider">{t(`${NS}.providerLabel`)}</Label>
              <Select
                value={provider}
                onValueChange={(value) => isManualProvider(value) && setProvider(value)}
              >
                <SelectTrigger id="bulk-fatura-provider">
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
              <Label htmlFor="bulk-fatura-response">{t(`${NS}.responseLabel`)}</Label>
              <Textarea
                id="bulk-fatura-response"
                className="h-40 font-mono text-xs"
                placeholder={t(`${NS}.responsePlaceholder`)}
                value={responseJson}
                disabled={upload.isPending}
                onChange={(event) => setResponseJson(event.target.value)}
              />
            </div>
          </div>
        ) : null}

        {step === 'result' ? (
          <div className="space-y-2">
            {results.map((result) => (
              <div key={result.cardName} className="rounded-md border p-3 text-sm">
                <p className="font-medium">{result.cardName}</p>
                <p className={result.status === 'draft' ? 'text-emerald-700' : 'text-destructive'}>
                  {result.status === 'draft' ? t(`${NS}.draftCreated`) : result.message}
                </p>
              </div>
            ))}
          </div>
        ) : null}

        <DialogFooter>
          {step === 'select' ? (
            <Button disabled={selectedIds.length === 0} onClick={() => setStep('extract')}>
              {t(`${NS}.continue`)}
            </Button>
          ) : null}
          {step === 'extract' ? (
            <>
              <Button
                variant="outline"
                disabled={upload.isPending}
                onClick={() => setStep('select')}
              >
                {t(`${NS}.back`)}
              </Button>
              <Button
                disabled={responseJson.trim().length === 0 || upload.isPending}
                onClick={submit}
              >
                {upload.isPending ? <Loader2 className="mr-2 size-4 animate-spin" /> : null}
                {t(`${NS}.submit`)}
              </Button>
            </>
          ) : null}
          {step === 'result' ? (
            <Button onClick={() => onOpenChange(false)}>{t(`${NS}.close`)}</Button>
          ) : null}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
