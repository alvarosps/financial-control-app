'use client';

import type { SimLever } from '@fc/shared';
import { Plus, RotateCcw, Trash2 } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { useId, useRef, useState } from 'react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { cn } from '@/lib/utils';
import { LEVER_EDITORS } from './editor-registry';
import {
  HORIZON_OPTIONS,
  LEVER_KINDS,
  type LeverKind,
  leverKindKey,
  leverLabel,
} from './lever-options';

/** Append the lever, or replace an existing one with the same id. Pure. */
export function upsertLever(levers: SimLever[], next: SimLever): SimLever[] {
  const idx = levers.findIndex((l) => l.id === next.id);
  if (idx === -1) return [...levers, next];
  const copy = levers.slice();
  copy[idx] = next;
  return copy;
}

/** Remove the lever with the given id. Pure. */
export function removeLever(levers: SimLever[], id: string): SimLever[] {
  return levers.filter((l) => l.id !== id);
}

/**
 * Parse a free-form opening-balance field into the canonical signed money
 * string the run input expects (`-?\d+\.\d{2}`). Unlike `toMoneyInputString`
 * this allows negatives and zero — real cash is frequently negative. Returns
 * `null` for blank/non-numeric input so the caller can fall back to the anchor.
 */
export function parseOpeningBalance(raw: string): string | null {
  const trimmed = raw.trim();
  if (trimmed === '') return null;
  const normalized = trimmed.includes(',') ? trimmed.replace(/\./g, '').replace(',', '.') : trimmed;
  const n = Number.parseFloat(normalized);
  if (!Number.isFinite(n)) return null;
  return n.toFixed(2);
}

type Props = {
  levers: SimLever[];
  onChange: (levers: SimLever[]) => void;
  horizon?: number;
  onHorizonChange?: (horizon: number) => void;
  /** The run's real anchor cash, shown as the default opening balance. */
  anchorCash?: number;
  /** Current opening-balance override (signed money string), if any. */
  openingBalanceOverride?: string;
  onOpeningBalanceChange?: (value: string | undefined) => void;
};

type EditorState = { kind: LeverKind; lever: SimLever | null } | null;

export function LeverPanel({
  levers,
  onChange,
  horizon,
  onHorizonChange,
  anchorCash,
  openingBalanceOverride,
  onOpeningBalanceChange,
}: Props) {
  const t = useTranslations();
  const openingId = useId();
  const [editor, setEditor] = useState<EditorState>(null);
  const [adding, setAdding] = useState(false);
  // An editor may emit MORE THAN ONE lever in a single synchronous session
  // (the recurring-cancel multi-select calls `onSubmit` once per checked
  // schedule). React batches the state updates, so each `submit` call would
  // otherwise upsert against the SAME stale `levers` snapshot and only the last
  // lever would survive. We accumulate the session's emissions into this ref
  // (seeded from `levers` on the first emit, reset whenever an editor opens).
  const pendingBatch = useRef<SimLever[] | null>(null);

  function openEditor(next: EditorState) {
    pendingBatch.current = null;
    setAdding(false);
    setEditor(next);
  }

  const anchorDisplay = anchorCash === undefined ? '' : anchorCash.toFixed(2);
  // The opening-balance field keeps a LOCAL draft string so the user can type
  // freely (mid-decimal, leading `-`, or fully cleared) without the value being
  // reformatted/snapped on every keystroke. The draft seeds from the current
  // override (or the anchor display) and is re-seeded only on *external* changes
  // (reset, anchor load) — never on the echo of our own commit.
  const externalOpening = openingBalanceOverride ?? anchorDisplay;
  const [openingDraft, setOpeningDraft] = useState(externalOpening);
  const [seenExternalOpening, setSeenExternalOpening] = useState(externalOpening);
  const lastCommittedOpening = useRef(externalOpening);
  if (externalOpening !== seenExternalOpening) {
    setSeenExternalOpening(externalOpening);
    if (externalOpening !== lastCommittedOpening.current) {
      setOpeningDraft(externalOpening);
    }
  }

  const showReset = openingBalanceOverride !== undefined && onOpeningBalanceChange !== undefined;

  function commitOpening(raw: string) {
    if (!onOpeningBalanceChange) return;
    const parsed = parseOpeningBalance(raw);
    lastCommittedOpening.current = parsed ?? anchorDisplay;
    onOpeningBalanceChange(parsed ?? undefined);
  }

  function resetOpening() {
    if (!onOpeningBalanceChange) return;
    lastCommittedOpening.current = anchorDisplay;
    setOpeningDraft(anchorDisplay);
    onOpeningBalanceChange(undefined);
  }

  function submit(lever: SimLever) {
    const base = pendingBatch.current ?? levers;
    const next = upsertLever(base, lever);
    pendingBatch.current = next;
    onChange(next);
    setEditor(null);
    setAdding(false);
  }

  function cancel() {
    pendingBatch.current = null;
    setEditor(null);
    setAdding(false);
  }

  function startAdd(kind: LeverKind) {
    openEditor({ kind, lever: null });
  }

  return (
    <Card surface="glass" className="lg:sticky lg:top-4 lg:self-start">
      <CardHeader>
        <CardTitle className="text-sm">{t('simulator.leverPanelTitle')}</CardTitle>
      </CardHeader>
      <CardContent className="space-y-5">
        {onOpeningBalanceChange && (
          <div className="space-y-1.5">
            <Label htmlFor={openingId} className="text-xs text-muted-foreground">
              {t('simulator.openingBalanceLabel')}
            </Label>
            <div className="flex items-center gap-2">
              <Input
                id={openingId}
                inputMode="decimal"
                value={openingDraft}
                placeholder={anchorDisplay}
                onChange={(e) => {
                  setOpeningDraft(e.target.value);
                  commitOpening(e.target.value);
                }}
                onBlur={(e) => commitOpening(e.target.value)}
              />
              {showReset && (
                <Button
                  size="icon-sm"
                  variant="ghost"
                  aria-label={t('simulator.openingBalanceReset')}
                  onClick={resetOpening}
                >
                  <RotateCcw className="size-3.5" />
                </Button>
              )}
            </div>
            <p className="text-xs text-muted-foreground">
              {t('simulator.openingBalanceHint', { value: anchorDisplay })}
            </p>
          </div>
        )}

        {onHorizonChange && (
          <div className="space-y-1.5">
            <Label className="text-xs text-muted-foreground">{t('simulator.horizonLabel')}</Label>
            <div className="flex gap-1.5">
              {HORIZON_OPTIONS.map((months) => (
                <Button
                  key={months}
                  size="sm"
                  variant={horizon === months ? 'brand' : 'outline'}
                  aria-pressed={horizon === months}
                  className="flex-1"
                  onClick={() => onHorizonChange(months)}
                >
                  {t('simulator.horizonMonths', { count: months })}
                </Button>
              ))}
            </div>
          </div>
        )}

        <div className="space-y-2">
          <ul className="space-y-2">
            {levers.map((lever) => (
              <li
                key={lever.id}
                className="flex items-center justify-between gap-2 rounded-lg border border-foreground/10 bg-muted/40 p-2"
              >
                <div className="min-w-0">
                  <p className="truncate text-sm font-medium">{leverLabel(lever)}</p>
                  <Badge variant="brand" className="mt-0.5">
                    {t(leverKindKey(lever.kind))}
                  </Badge>
                </div>
                <div className="flex shrink-0 gap-1">
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => openEditor({ kind: lever.kind, lever })}
                  >
                    {t('simulator.editLever')}
                  </Button>
                  <Button
                    size="icon-sm"
                    variant="ghost"
                    className="text-destructive hover:text-destructive"
                    aria-label={t('simulator.removeLeverAria', { label: leverLabel(lever) })}
                    onClick={() => onChange(removeLever(levers, lever.id))}
                  >
                    <Trash2 className="size-3.5" />
                  </Button>
                </div>
              </li>
            ))}
            {levers.length === 0 && (
              <li className="rounded-lg border border-dashed border-foreground/15 p-3 text-center text-xs text-muted-foreground">
                {t('simulator.noLevers')}
              </li>
            )}
          </ul>

          {editor !== null ? (
            <div className="rounded-lg border border-foreground/10 p-3">
              {(() => {
                const Editor = LEVER_EDITORS[editor.kind];
                return <Editor value={editor.lever} onSubmit={submit} onCancel={cancel} />;
              })()}
            </div>
          ) : adding ? (
            <div
              className="space-y-1 rounded-lg border border-foreground/10 p-1"
              role="menu"
              aria-label={t('simulator.addLever')}
            >
              {LEVER_KINDS.map((kind) => (
                <button
                  key={kind}
                  type="button"
                  role="menuitem"
                  className={cn(
                    'w-full rounded-md px-2.5 py-1.5 text-left text-sm transition-colors',
                    'hover:bg-muted focus-visible:bg-muted focus-visible:outline-none',
                  )}
                  onClick={() => startAdd(kind)}
                >
                  {t(leverKindKey(kind))}
                </button>
              ))}
            </div>
          ) : (
            <Button
              size="sm"
              variant="outline"
              className="w-full"
              aria-label={t('simulator.addLever')}
              onClick={() => setAdding(true)}
            >
              <Plus className="size-3.5" />
              {t('simulator.addLever')}
            </Button>
          )}
        </div>
      </CardContent>
    </Card>
  );
}
