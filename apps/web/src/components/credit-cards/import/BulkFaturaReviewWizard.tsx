'use client';

import { useTranslations } from 'next-intl';
import { useEffect, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { FaturaReviewDialog } from './FaturaReviewDialog';

export type BulkFaturaDraft = {
  importId: string;
  cardAccountId: string;
  cardName: string;
};

type Props = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  drafts: BulkFaturaDraft[];
  defaultSourceAccountId: string;
};

export function BulkFaturaReviewWizard({
  open,
  onOpenChange,
  drafts,
  defaultSourceAccountId,
}: Props) {
  const t = useTranslations();
  const [currentIndex, setCurrentIndex] = useState(0);
  const completedRef = useRef(false);
  const draft = drafts[currentIndex];

  useEffect(() => {
    if (!open) setCurrentIndex(0);
  }, [open]);

  function advance() {
    if (currentIndex + 1 < drafts.length) {
      setCurrentIndex((index) => index + 1);
      return;
    }
    onOpenChange(false);
  }

  if (!open || draft === undefined) return null;

  return (
    <FaturaReviewDialog
      importId={draft.importId}
      open={true}
      onOpenChange={(nextOpen) => {
        if (nextOpen) return;
        if (completedRef.current) {
          completedRef.current = false;
          return;
        }
        onOpenChange(false);
      }}
      defaultSourceAccountId={defaultSourceAccountId}
      onComplete={() => {
        completedRef.current = true;
        advance();
      }}
      headerContent={
        <div className="flex items-center justify-between gap-3 text-sm text-muted-foreground">
          <span>
            {t('components-credit-cards-import-faturareviewdialog.progress', {
              current: currentIndex + 1,
              total: drafts.length,
              name: draft.cardName,
            })}
          </span>
          <Button type="button" size="sm" variant="outline" onClick={advance}>
            {t('components-credit-cards-import-faturareviewdialog.skip')}
          </Button>
        </div>
      }
    />
  );
}
