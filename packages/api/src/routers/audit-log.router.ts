import { auditLog } from '@fc/db';
import { and, desc, eq, sql } from 'drizzle-orm';
import { z } from 'zod';
import { paginationSchema } from '../lib/pagination.ts';
import { protectedProcedure, router } from '../trpc.ts';

export const auditLogRouter = router({
  list: protectedProcedure
    .input(
      z.object({
        entityType: z.string().max(50).optional(),
        entityId: z.guid().optional(),
        ...paginationSchema.shape,
      }),
    )
    .query(async ({ ctx, input }) => {
      const { page, pageSize, entityType, entityId } = input;

      const conditions = [eq(auditLog.userId, ctx.userId)];
      if (entityType) conditions.push(eq(auditLog.entityType, entityType));
      if (entityId) conditions.push(eq(auditLog.entityId, entityId));

      const where = and(...conditions);

      const [countResult] = await ctx.db
        .select({ count: sql<number>`count(*)` })
        .from(auditLog)
        .where(where);

      const items = await ctx.db
        .select()
        .from(auditLog)
        .where(where)
        .orderBy(desc(auditLog.createdAt))
        .limit(pageSize)
        .offset((page - 1) * pageSize);

      const total = Number(countResult?.count ?? 0);

      return {
        items,
        total,
        page,
        pageSize,
        totalPages: Math.ceil(total / pageSize),
      };
    }),
});
