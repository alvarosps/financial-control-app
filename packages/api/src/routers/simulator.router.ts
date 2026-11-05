import { z } from 'zod';
import { MonthlyAveragesService } from '../services/monthly-averages.service.ts';
import {
  simAssumptionsSchema,
  simLeverSchema,
  simScenarioSchema,
} from '../services/simulator/scenario-schema.ts';
import { SimulatorService } from '../services/simulator.service.ts';
import { protectedProcedure, router } from '../trpc.ts';

const runInput = z.object({
  openingBalance: z
    .string()
    .regex(/^-?\d+\.\d{2}$/)
    .optional(),
  // Max 36 to match the UI horizon options + the persisted scenario schema
  // (scenario-schema.ts). getBaselineCores fetches horizon + 1 internally (cap 37).
  horizon: z.number().int().min(1).max(36).default(12),
  levers: z.array(simLeverSchema),
  assumptions: simAssumptionsSchema.optional(),
});

export const simulatorRouter = router({
  // Read-only: no materializer writes. The BalanceProjectionService consumes the
  // existing canonical month buckets; the horizon is ensured on the projection
  // read path (noOpGuard semantics — the read never materializes).
  run: protectedProcedure.input(runInput).query(async ({ ctx, input }) => {
    const service = new SimulatorService(ctx.db);
    return service.run(ctx.userId, {
      ...(input.openingBalance !== undefined && { openingBalance: input.openingBalance }),
      horizon: input.horizon,
      levers: input.levers,
      assumptions: input.assumptions,
    });
  }),

  // Read-only historical averages over the user's complete months (window
  // defaults to 12) that seed the average_spend + installment_growth lever
  // defaults. Scoped to ctx.userId.
  monthlyAverages: protectedProcedure
    .input(z.object({ window: z.number().int().min(1).max(24).optional() }).optional())
    .query(({ ctx, input }) =>
      new MonthlyAveragesService(ctx.db).getMonthlyAverages(ctx.userId, { window: input?.window }),
    ),

  // Read-only recent installment plans that seed the installment_plan lever
  // defaults. Scoped to ctx.userId.
  installmentSuggestions: protectedProcedure.query(({ ctx }) =>
    new MonthlyAveragesService(ctx.db).getInstallmentSuggestions(ctx.userId),
  ),

  listScenarios: protectedProcedure.query(async ({ ctx }) => {
    const service = new SimulatorService(ctx.db);
    return service.listScenarios(ctx.userId);
  }),

  saveScenario: protectedProcedure.input(simScenarioSchema).mutation(async ({ ctx, input }) => {
    const service = new SimulatorService(ctx.db);
    return service.saveScenario(ctx.userId, input);
  }),

  updateScenario: protectedProcedure
    .input(z.object({ id: z.guid(), scenario: simScenarioSchema }))
    .mutation(async ({ ctx, input }) => {
      const service = new SimulatorService(ctx.db);
      return service.updateScenario(ctx.userId, input.id, input.scenario);
    }),

  duplicateScenario: protectedProcedure
    .input(z.object({ id: z.guid(), name: z.string().min(1).max(200).optional() }))
    .mutation(async ({ ctx, input }) => {
      const service = new SimulatorService(ctx.db);
      return service.duplicateScenario(ctx.userId, input.id, input.name);
    }),

  deleteScenario: protectedProcedure
    .input(z.object({ id: z.guid() }))
    .mutation(async ({ ctx, input }) => {
      const service = new SimulatorService(ctx.db);
      return service.deleteScenario(ctx.userId, input.id);
    }),
});
