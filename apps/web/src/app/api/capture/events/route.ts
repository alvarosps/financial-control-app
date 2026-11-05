import { createServerDb, handleCaptureRequest } from '@fc/api';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(request: Request) {
  const url = process.env.APP_DATABASE_URL;
  if (process.env.CAPTURE_ANDROID_ENABLED !== 'true' || !url)
    return Response.json(
      { error: 'CAPTURE_DISABLED' },
      { status: 503, headers: { 'Cache-Control': 'no-store' } },
    );
  return handleCaptureRequest(request, createServerDb(url), 'events', true);
}
