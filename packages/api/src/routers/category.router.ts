import { z } from 'zod';
import { CategoryService } from '../services/category.service.ts';
import {
  ClassificationService,
  classificationApplySchema,
  classificationPeriodSchema,
  classificationRuleSchema,
  classificationUndoSchema,
} from '../services/classification.service.ts';
import { protectedProcedure, router } from '../trpc.ts';
import { categoryTypeSchema } from './schemas.ts';

export const categoryRouter = router({
  classificationPreview: protectedProcedure
    .input(classificationPeriodSchema)
    .query(({ ctx, input }) => new ClassificationService(ctx.db).preview(ctx.userId, input)),
  classificationRules: protectedProcedure.query(({ ctx }) =>
    new ClassificationService(ctx.db).rules(ctx.userId),
  ),
  classificationHistory: protectedProcedure.query(({ ctx }) =>
    new ClassificationService(ctx.db).history(ctx.userId),
  ),
  createClassificationRule: protectedProcedure
    .input(classificationRuleSchema)
    .mutation(({ ctx, input }) => new ClassificationService(ctx.db).createRule(ctx.userId, input)),
  setClassificationRuleEnabled: protectedProcedure
    .input(
      z.object({
        id: z.guid(),
        version: z.number().int().positive(),
        enabled: z.boolean(),
      }),
    )
    .mutation(({ ctx, input }) =>
      new ClassificationService(ctx.db).setRuleEnabled(
        ctx.userId,
        input.id,
        input.version,
        input.enabled,
      ),
    ),
  applyClassification: protectedProcedure
    .input(classificationApplySchema)
    .mutation(({ ctx, input }) => new ClassificationService(ctx.db).apply(ctx.userId, input)),
  undoClassification: protectedProcedure
    .input(classificationUndoSchema)
    .mutation(({ ctx, input }) => new ClassificationService(ctx.db).undo(ctx.userId, input)),
  list: protectedProcedure.query(async ({ ctx }) => {
    const service = new CategoryService(ctx.db);
    return service.listByUser(ctx.userId);
  }),

  getById: protectedProcedure.input(z.object({ id: z.guid() })).query(async ({ ctx, input }) => {
    const service = new CategoryService(ctx.db);
    return service.getById(ctx.userId, input.id);
  }),

  ensureDefaults: protectedProcedure.mutation(async ({ ctx }) => {
    const service = new CategoryService(ctx.db);
    return service.ensureDefaultCategories(ctx.userId);
  }),

  create: protectedProcedure
    .input(
      z.object({
        name: z.string().min(1).max(100),
        type: categoryTypeSchema,
        parentId: z.guid().optional(),
        icon: z.string().max(50).optional(),
        color: z.string().max(20).optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const service = new CategoryService(ctx.db);
      return service.create(ctx.userId, input);
    }),

  update: protectedProcedure
    .input(
      z.object({
        id: z.guid(),
        name: z.string().min(1).max(100).optional(),
        icon: z.string().max(50).optional(),
        color: z.string().max(20).optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const { id, ...data } = input;
      const service = new CategoryService(ctx.db);
      return service.update(ctx.userId, id, data);
    }),

  delete: protectedProcedure.input(z.object({ id: z.guid() })).mutation(async ({ ctx, input }) => {
    const service = new CategoryService(ctx.db);
    await service.delete(ctx.userId, input.id);
    return { success: true };
  }),
});
