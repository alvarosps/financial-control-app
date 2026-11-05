'use client';

import type { SimScenario } from '@fc/shared';
import { useTranslations } from 'next-intl';
import { useCallback } from 'react';
import { toast } from 'sonner';
import { trpc } from '@/lib/trpc/client';
import type { SavedScenarioRow } from './SavedScenarioCard';

type UseSavedScenarioActionsArgs = {
  /** Loads a scenario's levers/horizon/override back into the editing panel. */
  loadScenario: (scenario: SimScenario) => void;
};

export function useSavedScenarioActions({ loadScenario }: UseSavedScenarioActionsArgs) {
  const t = useTranslations();
  const utils = trpc.useUtils();

  const duplicate = trpc.simulator.duplicateScenario.useMutation({
    onSuccess: () => {
      utils.simulator.listScenarios.invalidate();
      toast.success(t('simulator.savedCard.duplicated'));
    },
    onError: (err) => toast.error(err.message || t('simulator.savedCard.duplicateFailed')),
  });

  const onRerun = useCallback(
    (row: SavedScenarioRow) => {
      loadScenario(row.scenario);
    },
    [loadScenario],
  );

  const onDuplicate = useCallback(
    (row: SavedScenarioRow) => {
      duplicate.mutate({ id: row.id });
    },
    [duplicate],
  );

  return { onRerun, onDuplicate, isDuplicating: duplicate.isPending };
}
