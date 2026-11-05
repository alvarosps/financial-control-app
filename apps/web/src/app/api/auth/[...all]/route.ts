import { createAuth, createServerDb } from '@fc/api';
import { toNextJsHandler } from 'better-auth/next-js';

/**
 * Lazy initialization: do NOT touch the DB at module top-level.
 * Next.js loads route modules during `next build` ("collect page data"),
 * so any top-level DB call would force a live database for builds.
 * The auth handler is built once on first request and cached.
 */
let cachedHandler: ReturnType<typeof toNextJsHandler> | null = null;

function getHandler() {
  if (cachedHandler) return cachedHandler;
  if (!process.env.APP_DATABASE_URL) {
    throw new Error('APP_DATABASE_URL environment variable is required (app_user role)');
  }
  const db = createServerDb(process.env.APP_DATABASE_URL);
  const auth = createAuth(db, process.env.NEXT_PUBLIC_APP_URL);
  cachedHandler = toNextJsHandler(auth);
  return cachedHandler;
}

export const GET = (req: Request) => getHandler().GET(req);
export const POST = (req: Request) => getHandler().POST(req);
