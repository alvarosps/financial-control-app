import type { DbExecutor } from '@fc/db';
import { simulationScenarios } from '@fc/db';
import {
  applyDeltas,
  computeAlerts,
  computeKpis,
  foldRunningBalance,
  type MonthCore,
  type ProjectedMonth,
  type ProjectionAlerts,
  type ProjectionKpis,
  type ResolvedDelta,
} from '@fc/domain';
import type { MonthRef, SimAssumptions, SimLever, SimScenario } from '@fc/shared';
import { TRPCError } from '@trpc/server';
import { and, eq } from 'drizzle-orm';
import { BalanceProjectionService } from './balance-projection.service.ts';
import { CashReadinessService } from './cash-readiness.service.ts';
import { ForecastContextService, type ForecastMonth } from './forecast-context.service.ts';
import { resolveAssumptions } from './simulator/resolve-assumptions.ts';
import { resolveLever } from './simulator/resolve-lever.ts';
import { simAssumptionsSchema, simScenarioSchema } from './simulator/scenario-schema.ts';

type ScenarioRow = typeof simulationScenarios.$inferSelect;

/** A persisted scenario row whose `parameters` jsonb is parsed back to a typed `SimScenario`. */
export type StoredScenario = Omit<ScenarioRow, 'parameters'> & { parameters: SimScenario };

export type RunInput = {
  openingBalance?: string;
  horizon: number;
  levers: SimLever[];
  asOf?: Date;
  assumptions?: SimAssumptions;
};

export type RunResult = {
  anchorCash: number;
  openingBalance: number;
  baseline: ProjectedMonth[];
  simulated: ProjectedMonth[];
  kpis: ProjectionKpis;
  alerts: ProjectionAlerts;
  forecast: ForecastMonth[];
  cashReadiness?: { ready: boolean; reasons: string[] };
  assumptions: SimAssumptions & {
    horizon: number;
    anchorSource: 'wallet_cash' | 'override';
    openingBalanceOverridden: boolean;
    asOf: string;
    currency: 'BRL';
  };
};

export class SimulatorService {
  private balanceProjection: BalanceProjectionService;

  constructor(private db: DbExecutor) {
    this.balanceProjection = new BalanceProjectionService(db);
  }

  /** The ordered list of MonthRefs covered by a baseline cores array. */
  private static monthsOf(cores: MonthCore[]): MonthRef[] {
    return cores.map((c) => ({ month: c.month, year: c.year }));
  }

  /**
   * Run a projection for display. The CURRENT (partial) month is NOT shown as a
   * row: the displayed projection STARTS AT THE NEXT FULL MONTH. Its opening
   * depends on the anchor mode:
   *
   * - **Override** (`input.openingBalance` given): the entered value IS the
   *   balance at the first displayed month's day 1 (00:00 on the current→next
   *   month turn). The current month — and any current-month lever — is BYPASSED:
   *   only inflows/outflows from the next month on are projected. The current
   *   month's net is NOT applied to the override.
   * - **Wallet cash** (no override): seed the CURRENT month with the real cash
   *   anchor and fold, so the first displayed month opens at the current month's
   *   projected ENDING (a current-month lever folds into that opening).
   *
   * We fetch `displayHorizon + 1` cores (index 0 = the current month, then
   * `displayHorizon` future months) and resolve levers over the full internal
   * horizon (so current-month levers still resolve for the wallet-cash fold).
   * Either way index 0 is dropped from the display.
   *
   * `kpis.openingNow` is always the real wallet-cash anchor ("Saldo atual") —
   * never the override, which sets the NEXT month's opening, not current cash.
   * The returned `openingBalance` is the displayed projection's starting balance.
   */
  async run(userId: string, input: RunInput): Promise<RunResult> {
    const asOf = input.asOf ?? new Date();
    const displayHorizon = input.horizon;
    const internalHorizon = displayHorizon + 1;

    const assumptions = simAssumptionsSchema.parse(input.assumptions ?? {});
    const forecast = await new ForecastContextService(this.db).getMonths(
      userId,
      { month: asOf.getMonth() + 1, year: asOf.getFullYear() },
      internalHorizon,
      asOf,
    );
    const cores = await this.balanceProjection.getBaselineCores(userId, {
      horizon: internalHorizon,
      asOf,
      forecast,
    });
    const anchorCashStr = await this.balanceProjection.getAnchorCash(userId, asOf);
    const anchorCash = Number(anchorCashStr);

    const override = input.openingBalance;
    const overridden = override !== undefined;

    const months = SimulatorService.monthsOf(cores);

    // Lever resolvers are independent reads (each returns its own `byMonth`),
    // and `applyDeltas` is order-independent, so we resolve them concurrently on
    // the pooled `db` rather than sequentially awaiting each. Resolved over the
    // full internal horizon so a current-month lever still resolves (and folds
    // into the opening on the wallet-cash path, where its month is dropped).
    const deltas: ResolvedDelta[] = await Promise.all(
      input.levers.map((lever) =>
        resolveLever(this.db, userId, lever, { months, horizon: internalHorizon, asOf }),
      ),
    );
    const simulatedCores = applyDeltas(cores, [
      ...deltas,
      resolveAssumptions(forecast, assumptions),
    ]);

    let baseline: ProjectedMonth[];
    let simulated: ProjectedMonth[];
    if (override !== undefined) {
      // Override = the first displayed month's opening (day 1). Drop the current
      // month entirely and seed the displayed months from the override, so the
      // current month and any current-month lever are bypassed.
      baseline = foldRunningBalance(cores.slice(1), override);
      simulated = foldRunningBalance(simulatedCores.slice(1), override);
    } else {
      // Wallet cash: fold from the real anchor through the current month; the
      // carry invariant makes the first displayed month open at the current
      // month's projected ending (current-month levers fold into that opening).
      baseline = foldRunningBalance(cores, anchorCashStr).slice(1);
      simulated = foldRunningBalance(simulatedCores, anchorCashStr).slice(1);
    }

    const projectionOpening = simulated.length > 0 ? simulated[0].openingBalance : anchorCash;

    // openingNow is the real current cash ("Saldo atual") — always the
    // wallet-cash anchor, never the override.
    const kpis = computeKpis(baseline, simulated, anchorCash);
    const alerts = computeAlerts(baseline, simulated);
    const cashReadiness = await new CashReadinessService(this.db).get(userId, asOf);

    return {
      anchorCash,
      openingBalance: projectionOpening,
      baseline,
      simulated,
      kpis,
      alerts,
      forecast,
      cashReadiness: { ready: cashReadiness.ready, reasons: cashReadiness.reasons },
      assumptions: {
        ...assumptions,
        horizon: displayHorizon,
        anchorSource: overridden ? 'override' : 'wallet_cash',
        openingBalanceOverridden: overridden,
        asOf: asOf.toISOString(),
        currency: 'BRL',
      },
    };
  }

  // --- Scenario CRUD (fully implemented in Task 14) ---

  /** Re-typed view of a row: parse the stored jsonb back into a typed `SimScenario`. */
  private static withTypedParameters(row: ScenarioRow): StoredScenario {
    return { ...row, parameters: simScenarioSchema.parse(row.parameters) };
  }

  async listScenarios(userId: string): Promise<StoredScenario[]> {
    const rows = await this.db
      .select()
      .from(simulationScenarios)
      .where(eq(simulationScenarios.userId, userId));
    return rows.map(SimulatorService.withTypedParameters);
  }

  async saveScenario(userId: string, scenario: SimScenario): Promise<StoredScenario> {
    const parameters = simScenarioSchema.parse(scenario);
    const [row] = await this.db
      .insert(simulationScenarios)
      .values({ userId, name: parameters.name, type: 'scenario', parameters })
      .returning();
    return SimulatorService.withTypedParameters(row);
  }

  async updateScenario(userId: string, id: string, scenario: SimScenario): Promise<StoredScenario> {
    const parameters = simScenarioSchema.parse(scenario);
    const [row] = await this.db
      .update(simulationScenarios)
      .set({ name: parameters.name, parameters, updatedAt: new Date() })
      .where(and(eq(simulationScenarios.id, id), eq(simulationScenarios.userId, userId)))
      .returning();
    if (!row) throw new TRPCError({ code: 'NOT_FOUND', message: 'Scenario not found' });
    return SimulatorService.withTypedParameters(row);
  }

  async duplicateScenario(userId: string, id: string, name?: string): Promise<StoredScenario> {
    const [existing] = await this.db
      .select()
      .from(simulationScenarios)
      .where(and(eq(simulationScenarios.id, id), eq(simulationScenarios.userId, userId)));
    if (!existing) throw new TRPCError({ code: 'NOT_FOUND', message: 'Scenario not found' });

    const source = simScenarioSchema.parse(existing.parameters);
    const copyName = name ?? `${source.name} (copy)`;
    const parameters: SimScenario = { ...source, name: copyName };
    const [row] = await this.db
      .insert(simulationScenarios)
      .values({ userId, name: copyName, type: 'scenario', parameters })
      .returning();
    return SimulatorService.withTypedParameters(row);
  }

  async deleteScenario(userId: string, id: string): Promise<{ success: true }> {
    const [scenario] = await this.db
      .select()
      .from(simulationScenarios)
      .where(and(eq(simulationScenarios.id, id), eq(simulationScenarios.userId, userId)));
    if (!scenario) throw new TRPCError({ code: 'NOT_FOUND', message: 'Scenario not found' });

    await this.db
      .delete(simulationScenarios)
      .where(and(eq(simulationScenarios.id, id), eq(simulationScenarios.userId, userId)));
    return { success: true };
  }
}
