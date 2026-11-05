'use client';

import { computeSavingsGoal, type ProjectedMonth } from '@fc/domain';
import type { SimAssumptions, SimLever, SimScenario } from '@fc/shared';
import { Download, FlaskConical, Save } from 'lucide-react';
import dynamic from 'next/dynamic';
import { useTranslations } from 'next-intl';
import { useCallback, useEffect, useState } from 'react';
import { toast } from 'sonner';
import { EmptyState } from '@/components/shared/EmptyState';
import { ErrorAlert } from '@/components/shared/ErrorAlert';
import { ForecastDisclosure } from '@/components/shared/ForecastDisclosure';
import { PageHeader } from '@/components/shared/PageHeader';
import { SkeletonCard } from '@/components/shared/SkeletonCard';
import { ExportScenarioDialog } from '@/components/simulator/ExportScenarioDialog';
import { ForecastAssumptions } from '@/components/simulator/ForecastAssumptions';
import { SavedScenarioCard, type SavedScenarioRow } from '@/components/simulator/SavedScenarioCard';
import { SimulatorAlerts } from '@/components/simulator/SimulatorAlerts';
import { SimulatorKpis } from '@/components/simulator/SimulatorKpis';
import { SimulatorMonthTable } from '@/components/simulator/SimulatorMonthTable';
import type { CompareScenario } from '@/components/simulator/scenario-compare-series';
import { useSavedScenarioActions } from '@/components/simulator/use-saved-scenario-actions';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { usePageTitle } from '@/hooks/usePageTitle';
import { trpc } from '@/lib/trpc/client';
import { LeverPanel } from './levers/LeverPanel';

const RunningBalanceChart = dynamic(
  () =>
    import('@/components/simulator/RunningBalanceChart').then(
      (module) => module.RunningBalanceChart,
    ),
  { ssr: false, loading: () => <SkeletonCard /> },
);
const ScenarioCompare = dynamic(
  () => import('@/components/simulator/ScenarioCompare').then((module) => module.ScenarioCompare),
  { ssr: false, loading: () => <SkeletonCard /> },
);

const DEFAULT_HORIZON = 12;

export function SimulatorClient() {
  const t = useTranslations();
  usePageTitle(t('pageTitles.simulator'));

  // Run inputs driven by the LeverPanel (Task 22). Editing any of them re-runs
  // `simulator.run`, which already honors the override/horizon/levers passed in.
  const [assumptions, setAssumptions] = useState<SimAssumptions>({ familyReceiptPercent: 100 });
  const [levers, setLevers] = useState<SimLever[]>([]);
  const [horizon, setHorizon] = useState(DEFAULT_HORIZON);
  const [openingBalanceOverride, setOpeningBalanceOverride] = useState<string | undefined>(
    undefined,
  );
  const [exportOpen, setExportOpen] = useState(false);

  const { data, isLoading, error } = trpc.simulator.run.useQuery({
    horizon,
    levers,
    assumptions,
    ...(openingBalanceOverride ? { openingBalance: openingBalanceOverride } : {}),
  });

  // A `savings_goal` lever carries no projection delta; its analysis is derived
  // client-side from the simulated chain so the KPI tile and chart target line
  // stay in sync with the run result.
  const goalLever = levers.find((lever) => lever.kind === 'savings_goal');
  const savingsGoal =
    goalLever && data
      ? computeSavingsGoal(data.simulated, data.openingBalance, goalLever.target, goalLever.byMonth)
      : undefined;
  const targetLine = goalLever
    ? { value: Number(goalLever.target), label: t('simulator.chart.target') }
    : undefined;

  // The export scenario mirrors the live run inputs so the exported artifacts
  // describe exactly what the user is currently looking at.
  const exportScenario: SimScenario = {
    name: t('simulator.export.scenarioName'),
    horizon,
    levers,
    assumptions,
    ...(openingBalanceOverride ? { openingBalanceOverride } : {}),
  };

  return (
    <div className="space-y-6">
      <div className="flex items-start gap-3">
        <span className="grid size-10 shrink-0 place-items-center rounded-xl bg-primary/15 text-primary">
          <FlaskConical className="size-5" />
        </span>
        <PageHeader title={t('simulator.title')} subtitle={t('simulator.subtitle')} />
        <Button
          variant="outline"
          size="sm"
          className="ml-auto shrink-0"
          disabled={!data}
          onClick={() => setExportOpen(true)}
        >
          <Download className="size-3.5" />
          {t('simulator.export.openButton')}
        </Button>
      </div>

      {data && (
        <ExportScenarioDialog
          run={data}
          scenario={exportScenario}
          open={exportOpen}
          onOpenChange={setExportOpen}
        />
      )}

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-[20rem_1fr]">
        <div className="space-y-4">
          <ForecastAssumptions
            value={assumptions}
            onChange={setAssumptions}
            currencies={[
              ...new Set(
                data?.forecast.flatMap((month) => month.sources.map((source) => source.currency)) ??
                  [],
              ),
            ]}
          />
          <LeverPanel
            levers={levers}
            onChange={setLevers}
            horizon={horizon}
            onHorizonChange={setHorizon}
            anchorCash={data?.anchorCash}
            openingBalanceOverride={openingBalanceOverride}
            onOpeningBalanceChange={setOpeningBalanceOverride}
          />
        </div>

        <div className="space-y-6">
          {error && <ErrorAlert message={error.message || t('simulator.loadError')} />}

          {isLoading && (
            <div className="space-y-4">
              <SkeletonCard />
              <SkeletonCard />
            </div>
          )}

          {data && data.simulated.length === 0 && (
            <EmptyState
              icon={<FlaskConical className="size-10" />}
              title={t('simulator.empty')}
              description={t('simulator.subtitle')}
            />
          )}

          {data && data.simulated.length > 0 && (
            <>
              <ForecastDisclosure months={data.forecast} />
              {!data.cashReadiness?.ready && (
                <p role="status" className="text-sm text-muted-foreground">
                  {t('loanCost.simulationCash')}
                </p>
              )}
              <p className="text-xs text-muted-foreground">{t('loanCost.simulationHint')}</p>
              <SimulatorKpis
                kpis={data.kpis}
                firstOverdraft={data.alerts.firstNegativeMonthSimulated}
                savingsGoal={savingsGoal}
              />
              <SimulatorAlerts alerts={data.alerts} />
              <RunningBalanceChart
                baseline={data.baseline}
                simulated={data.simulated}
                targetLine={targetLine}
              />
              <SimulatorMonthTable baseline={data.baseline} simulated={data.simulated} />
            </>
          )}
        </div>
      </div>

      <SavedScenarios
        horizon={horizon}
        assumptions={assumptions}
        levers={levers}
        openingBalanceOverride={openingBalanceOverride}
        onLoadScenario={(scenario) => {
          setAssumptions(scenario.assumptions ?? { familyReceiptPercent: 100 });
          setLevers(scenario.levers);
          setHorizon(scenario.horizon);
          setOpeningBalanceOverride(scenario.openingBalanceOverride);
        }}
      />
    </div>
  );
}

type SavedScenariosProps = {
  assumptions: SimAssumptions;
  horizon: number;
  levers: SimLever[];
  openingBalanceOverride: string | undefined;
  onLoadScenario: (scenario: SimScenario) => void;
};

function SavedScenarios({
  assumptions,
  horizon,
  levers,
  openingBalanceOverride,
  onLoadScenario,
}: SavedScenariosProps) {
  const t = useTranslations();
  const utils = trpc.useUtils();
  const [name, setName] = useState('');
  const [compareIds, setCompareIds] = useState<string[]>([]);

  const { data, isLoading } = trpc.simulator.listScenarios.useQuery();

  // Map the persisted rows (`parameters` jsonb + `Date` createdAt) onto the
  // `SavedScenarioRow` contract the card consumes. No ending summary is persisted
  // yet, so the card omits it; each scenario's projection is recomputed on re-run.
  const rows: SavedScenarioRow[] = (data ?? []).map((row) => ({
    id: row.id,
    name: row.name,
    createdAt: row.createdAt.toISOString(),
    scenario: row.parameters,
  }));

  const saveScenario = trpc.simulator.saveScenario.useMutation({
    onSuccess: () => {
      setName('');
      toast.success(t('simulator.saved.saved'));
      utils.simulator.listScenarios.invalidate();
    },
    onError: (err) => toast.error(err.message || t('simulator.saved.saveFailed')),
  });

  const deleteScenario = trpc.simulator.deleteScenario.useMutation({
    onSuccess: () => utils.simulator.listScenarios.invalidate(),
    onError: (err) => toast.error(err.message || t('simulator.saved.deleteFailed')),
  });

  // Re-run reloads the scenario into the lever panel (which re-runs the
  // projection) and pre-fills the save-name input so a tweaked copy is easy to
  // save; Duplicate persists a copy server-side. Both are extracted into a
  // tested hook so this component stays a thin shell over the run inputs.
  const { onRerun, onDuplicate, isDuplicating } = useSavedScenarioActions({
    loadScenario: (scenario) => {
      onLoadScenario(scenario);
      setName(scenario.name);
    },
  });

  const trimmedName = name.trim();
  const handleSave = () => {
    if (!trimmedName) return;
    const scenario: SimScenario = {
      name: trimmedName,
      version: 2,
      assumptions,
      horizon,
      levers,
      ...(openingBalanceOverride ? { openingBalanceOverride } : {}),
    };
    saveScenario.mutate(scenario);
  };

  // Toggling a card in/out of the compare set; the overlay only renders once at
  // least two are selected (each selected scenario runs its own `simulator.run`).
  const toggleCompare = (row: SavedScenarioRow) => {
    setCompareIds((ids) =>
      ids.includes(row.id) ? ids.filter((id) => id !== row.id) : [...ids, row.id],
    );
  };

  // Drop compare selections that no longer exist (e.g. after a delete) so the
  // overlay never references a stale scenario id.
  const knownIds = rows.map((row) => row.id).join(',');
  // biome-ignore lint/correctness/useExhaustiveDependencies: prune keyed by the stable id list, not the row objects
  useEffect(() => {
    const existing = new Set(rows.map((row) => row.id));
    setCompareIds((ids) => {
      const next = ids.filter((id) => existing.has(id));
      return next.length === ids.length ? ids : next;
    });
  }, [knownIds]);

  const compareRows = rows.filter((row) => compareIds.includes(row.id));

  return (
    <div className="space-y-4">
      <h2 className="text-lg font-semibold">{t('simulator.saved.heading')}</h2>

      <div className="flex flex-wrap items-end gap-2">
        <div className="flex min-w-0 flex-1 flex-col gap-1">
          <label className="text-xs text-muted-foreground" htmlFor="save-scenario-name">
            {t('simulator.saved.nameLabel')}
          </label>
          <Input
            id="save-scenario-name"
            value={name}
            onChange={(event) => setName(event.target.value)}
            placeholder={t('simulator.saved.namePlaceholder')}
          />
        </div>
        <Button
          variant="outline"
          onClick={handleSave}
          disabled={!trimmedName || saveScenario.isPending}
        >
          <Save className="size-3.5" />
          {t('simulator.saved.saveButton')}
        </Button>
      </div>

      {isLoading && <SkeletonCard />}

      {data && data.length === 0 && (
        <Card surface="solid">
          <CardContent>
            <EmptyState
              icon={<FlaskConical className="size-10" />}
              title={t('simulator.saved.empty')}
            />
          </CardContent>
        </Card>
      )}

      {rows.length > 0 && (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
          {rows.map((row) => (
            <SavedScenarioCard
              key={row.id}
              row={row}
              selectedForCompare={compareIds.includes(row.id)}
              duplicateDisabled={isDuplicating}
              onRerun={onRerun}
              onDuplicate={onDuplicate}
              onCompareToggle={toggleCompare}
              onDelete={(r) => deleteScenario.mutate({ id: r.id })}
            />
          ))}
        </div>
      )}

      {compareRows.length >= 2 && <CompareOverlay rows={compareRows} />}
    </div>
  );
}

type CompareOverlayProps = {
  rows: SavedScenarioRow[];
};

/**
 * Runs each selected scenario through `simulator.run` and overlays their
 * simulated running balances. The run is a tRPC query and React forbids calling
 * hooks in a variable-length loop, so each scenario is driven by its own child
 * (`CompareScenarioRunner`) that runs its query and lifts its `simulated`
 * horizon up here. The overlay renders the scenarios whose runs have resolved.
 */
function CompareOverlay({ rows }: CompareOverlayProps) {
  const [results, setResults] = useState<Record<string, ProjectedMonth[]>>({});

  const onResult = useCallback((id: string, simulated: ProjectedMonth[]) => {
    setResults((prev) => ({ ...prev, [id]: simulated }));
  }, []);

  const scenarios: CompareScenario[] = rows
    .filter((row) => results[row.id])
    .map((row) => ({ id: row.id, name: row.name, simulated: results[row.id] }));

  return (
    <>
      {rows.map((row) => (
        <CompareScenarioRunner key={row.id} row={row} onResult={onResult} />
      ))}
      <ScenarioCompare scenarios={scenarios} />
    </>
  );
}

type CompareScenarioRunnerProps = {
  row: SavedScenarioRow;
  onResult: (id: string, simulated: ProjectedMonth[]) => void;
};

/** Headless per-scenario runner: runs `simulator.run` and lifts the result. */
function CompareScenarioRunner({ row, onResult }: CompareScenarioRunnerProps) {
  const { scenario } = row;
  const { data } = trpc.simulator.run.useQuery({
    horizon: scenario.horizon,
    levers: scenario.levers,
    assumptions: scenario.assumptions,
    ...(scenario.openingBalanceOverride ? { openingBalance: scenario.openingBalanceOverride } : {}),
  });

  const simulated = data?.simulated;
  useEffect(() => {
    if (simulated) onResult(row.id, simulated);
  }, [simulated, row.id, onResult]);

  return null;
}
