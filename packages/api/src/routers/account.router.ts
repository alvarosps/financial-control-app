import { z } from 'zod';
import { paginationSchema } from '../lib/pagination.ts';
import { AccountService } from '../services/account.service.ts';
import { WalletCashService } from '../services/wallet-cash.service.ts';
import { protectedProcedure, router } from '../trpc.ts';
import { accountTypeSchema, moneySchema, moneySchemaAllowNegative } from './schemas.ts';

export const accountRouter = router({
  list: protectedProcedure
    .input(paginationSchema.partial().optional())
    .query(async ({ ctx, input }) => {
      const service = new AccountService(ctx.db);
      if (input?.page !== undefined) {
        return service.listByUser(ctx.userId, input.page, input.pageSize);
      }
      return service.listByUser(ctx.userId);
    }),

  listWallets: protectedProcedure.query(async ({ ctx }) => {
    return new AccountService(ctx.db).listWallets(ctx.userId);
  }),

  walletsOverview: protectedProcedure.query(async ({ ctx }) => {
    const accountService = new AccountService(ctx.db);
    const walletCash = new WalletCashService(ctx.db);
    const [wallets, cash] = await Promise.all([
      accountService.listWallets(ctx.userId),
      walletCash.getWalletCash(ctx.userId),
    ]);
    const cashById = new Map(cash.wallets.map((w) => [w.id, w]));
    return {
      wallets: wallets.map((w) => ({
        id: w.id,
        name: w.name,
        currency: w.currency,
        isDefaultWallet: w.isDefaultWallet,
        overdraftLimit: w.overdraftLimit,
        openingBalance: w.openingBalance,
        cashQuality: cashById.get(w.id),
        cash: cashById.get(w.id)?.cash ?? Number(w.openingBalance),
      })),
      totalCash: cash.totalCash,
    };
  }),

  walletCashSeries: protectedProcedure
    .input(z.object({ days: z.number().int().min(7).max(90).default(30) }).optional())
    .query(async ({ ctx, input }) =>
      new WalletCashService(ctx.db).getWalletCashSeries(ctx.userId, input?.days ?? 30),
    ),

  setDefaultWallet: protectedProcedure
    .input(z.object({ id: z.guid() }))
    .mutation(async ({ ctx, input }) => {
      return new AccountService(ctx.db).setDefaultWallet(ctx.userId, input.id);
    }),

  balanceAdjustmentPreview: protectedProcedure
    .input(z.object({ id: z.guid() }))
    .query(({ ctx, input }) =>
      new AccountService(ctx.db).balanceAdjustmentPreview(ctx.userId, input.id),
    ),

  reanchorWallet: protectedProcedure
    .input(
      z.object({
        id: z.guid(),
        cash: moneySchemaAllowNegative,
        expectedRevision: z.string().regex(/^[a-f0-9]{64}$/),
        reason: z.string().trim().min(3).max(500),
      }),
    )
    .mutation(async ({ ctx, input }) =>
      new AccountService(ctx.db).reanchorWallet(ctx.userId, input.id, input.cash, input),
    ),

  getById: protectedProcedure.input(z.object({ id: z.guid() })).query(async ({ ctx, input }) => {
    const service = new AccountService(ctx.db);
    return service.getById(ctx.userId, input.id);
  }),

  create: protectedProcedure
    .input(
      z.object({
        name: z.string().min(1).max(200),
        type: accountTypeSchema,
        currency: z.string().length(3),
        icon: z.string().max(50).optional(),
        color: z.string().max(20).optional(),
        overdraftLimit: moneySchema.optional(),
        cdiPercentage: z
          .string()
          .regex(/^\d+\.\d{2}$/)
          .optional(),
        parentAccountId: z.guid().optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const service = new AccountService(ctx.db);
      return service.create(ctx.userId, input);
    }),

  update: protectedProcedure
    .input(
      z.object({
        id: z.guid(),
        name: z.string().min(1).max(200).optional(),
        icon: z.string().max(50).optional(),
        color: z.string().max(20).optional(),
        overdraftLimit: moneySchema.optional(),
        cdiPercentage: z
          .string()
          .regex(/^\d+\.\d{2}$/)
          .optional(),
        sortOrder: z.number().int().optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const { id, ...fields } = input;
      const service = new AccountService(ctx.db);
      return service.update(ctx.userId, id, fields);
    }),

  deactivate: protectedProcedure
    .input(z.object({ id: z.guid() }))
    .mutation(async ({ ctx, input }) => {
      const service = new AccountService(ctx.db);
      return service.deactivate(ctx.userId, input.id);
    }),
});
