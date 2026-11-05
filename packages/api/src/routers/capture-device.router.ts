import { TRPCError } from '@trpc/server';
import { z } from 'zod';
import {
  CaptureDeviceService,
  createCapturePairingSchema,
} from '../services/capture-device.service.ts';
import { protectedProcedure, router } from '../trpc.ts';

export const captureDeviceRouter = router({
  list: protectedProcedure.query(async ({ ctx }) => ({
    enabled: process.env.CAPTURE_ANDROID_ENABLED === 'true',
    devices: await new CaptureDeviceService(ctx.db).list(ctx.userId),
  })),
  createPairing: protectedProcedure.input(createCapturePairingSchema).mutation(({ ctx, input }) => {
    if (process.env.CAPTURE_ANDROID_ENABLED !== 'true')
      throw new TRPCError({ code: 'PRECONDITION_FAILED', message: 'Capture is disabled' });
    return new CaptureDeviceService(ctx.db).createPairing(ctx.userId, input);
  }),
  revoke: protectedProcedure
    .input(z.object({ deviceId: z.guid() }).strict())
    .mutation(({ ctx, input }) =>
      new CaptureDeviceService(ctx.db).revoke(ctx.userId, input.deviceId),
    ),
});
