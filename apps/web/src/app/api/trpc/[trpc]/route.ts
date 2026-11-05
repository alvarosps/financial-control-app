import {
  appRouter,
  createAuth,
  createRequestProfileCache,
  createServerDb,
  type Database,
  reportTRPCError,
  resolveUserProfileByAuthUserId,
  type TRPCContext,
} from '@fc/api';
import { fetchRequestHandler } from '@trpc/server/adapters/fetch';

function getDb(): Database {
  if (!process.env.APP_DATABASE_URL) {
    throw new Error('APP_DATABASE_URL environment variable is required (app_user role)');
  }
  return createServerDb(process.env.APP_DATABASE_URL);
}

const handler = async (req: Request) => {
  const db = getDb();
  const auth = createAuth(db, process.env.NEXT_PUBLIC_APP_URL);
  const session = await auth.api.getSession({ headers: req.headers });

  let userId: string | null = null;
  if (session?.user) {
    const profile = await resolveUserProfileByAuthUserId(db, session.user.id);
    userId = profile?.id ?? null;
  }

  return fetchRequestHandler({
    endpoint: '/api/trpc',
    req,
    router: appRouter,
    onError: reportTRPCError,
    createContext: async (): Promise<TRPCContext> => ({
      db,
      userId,
      profileCache: createRequestProfileCache(db),
    }),
  });
};

export { handler as GET, handler as POST };
