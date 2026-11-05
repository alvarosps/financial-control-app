'use client';

import { useTranslations } from 'next-intl';
import { Button } from '@/components/ui/button';

/**
 * Shared footer for the per-kind lever editors: a ghost Cancel and a brand
 * submit button. The submit label is `save` when editing an existing lever and
 * `add` when creating one, and is disabled unless `canSubmit`. The markup and
 * classes are identical to the inline footer the editors previously duplicated.
 */
export function LeverEditorFooter({
  existing,
  canSubmit,
  onCancel,
  onSubmit,
}: {
  existing: boolean;
  canSubmit: boolean;
  onCancel: () => void;
  onSubmit: () => void;
}) {
  const t = useTranslations();
  return (
    <div className="flex justify-end gap-2">
      <Button size="sm" variant="ghost" onClick={onCancel}>
        {t('simulator.leverEditor.cancel')}
      </Button>
      <Button size="sm" variant="brand" disabled={!canSubmit} onClick={onSubmit}>
        {existing ? t('simulator.leverEditor.save') : t('simulator.leverEditor.add')}
      </Button>
    </div>
  );
}
