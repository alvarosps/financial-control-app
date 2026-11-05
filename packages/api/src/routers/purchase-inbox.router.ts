import { z } from 'zod';
import {
  ingestFinancialEventSchema,
  purchaseAcceptSchema,
  purchaseLinkSchema,
  purchaseListSchema,
  purchaseReviewSchema,
  purchaseSeparateEvidenceSchema,
  purchaseVersionSchema,
} from '../lib/purchase-input.ts';
import { DataCoverageService } from '../services/data-coverage.service.ts';
import { FinancialEventService } from '../services/financial-event.service.ts';
import { PurchaseInboxService } from '../services/purchase-inbox.service.ts';
import { protectedProcedure, router } from '../trpc.ts';

export const purchaseInboxRouter = router({
  coverage: protectedProcedure
    .input(z.object({ cardAccountId: z.guid().optional() }).strict().default({}))
    .query(({ ctx, input }) =>
      new DataCoverageService(ctx.db).get(ctx.userId, input.cardAccountId),
    ),
  metrics: protectedProcedure.query(({ ctx }) =>
    new DataCoverageService(ctx.db).metrics(ctx.userId),
  ),
  capture: protectedProcedure
    .input(
      ingestFinancialEventSchema.refine(
        (input) => input.source === 'manual' && input.data.confirmation === 'observed',
      ),
    )
    .mutation(({ ctx, input }) => new FinancialEventService(ctx.db).ingest(ctx.userId, input)),
  list: protectedProcedure
    .input(purchaseListSchema)
    .query(({ ctx, input }) => new PurchaseInboxService(ctx.db).list(ctx.userId, input)),
  detail: protectedProcedure
    .input(z.object({ id: z.guid() }).strict())
    .query(({ ctx, input }) => new PurchaseInboxService(ctx.db).detail(ctx.userId, input.id)),
  review: protectedProcedure
    .input(purchaseReviewSchema)
    .mutation(({ ctx, input }) => new PurchaseInboxService(ctx.db).review(ctx.userId, input)),
  accept: protectedProcedure
    .input(purchaseAcceptSchema)
    .mutation(({ ctx, input }) => new PurchaseInboxService(ctx.db).accept(ctx.userId, input)),
  link: protectedProcedure
    .input(purchaseLinkSchema)
    .mutation(({ ctx, input }) => new PurchaseInboxService(ctx.db).link(ctx.userId, input)),
  separateEvidence: protectedProcedure
    .input(purchaseSeparateEvidenceSchema)
    .mutation(({ ctx, input }) =>
      new PurchaseInboxService(ctx.db).separateEvidence(ctx.userId, input),
    ),
  ignore: protectedProcedure
    .input(purchaseVersionSchema.strict())
    .mutation(({ ctx, input }) => new PurchaseInboxService(ctx.db).ignore(ctx.userId, input)),
  unlink: protectedProcedure
    .input(purchaseVersionSchema.strict())
    .mutation(({ ctx, input }) => new PurchaseInboxService(ctx.db).unlink(ctx.userId, input)),
  reprocess: protectedProcedure
    .input(purchaseVersionSchema.strict())
    .mutation(({ ctx, input }) => new PurchaseInboxService(ctx.db).reprocess(ctx.userId, input)),
});
