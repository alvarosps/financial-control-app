import 'server-only';

import {
  type AppRouter,
  appRouter,
  createAuth,
  createCallerFactory,
  createRequestProfileCache,
  resolveUserProfileByAuthUserId,
  type TRPCContext,
} from '@fc/api';
import { createHydrationHelpers } from '@trpc/react-query/rsc';
import { headers } from 'next/headers';
import { cache } from 'react';
import { getServerDb } from '../server-db';
import { makeQueryClient } from './query-client';

const getContext = cache(async (): Promise<TRPCContext> => {
  const db = getServerDb();
  const auth = createAuth(db, process.env.NEXT_PUBLIC_APP_URL);
  const headersList = await headers();
  const session = await auth.api.getSession({ headers: headersList });

  let userId: string | null = null;
  if (session?.user) {
    const profile = await resolveUserProfileByAuthUserId(db, session.user.id);
    userId = profile?.id ?? null;
  }

  return { db, userId, profileCache: createRequestProfileCache(db) };
});

const caller = createCallerFactory(appRouter)(getContext);

export const getQueryClient = cache(makeQueryClient);

export const { trpc, HydrateClient } = createHydrationHelpers<AppRouter>(caller, getQueryClient);

export const getServerCaller = cache(async () =>
  createCallerFactory(appRouter)(await getContext()),
);
