import type { DbExecutor } from '@fc/db';
import { TRPCError } from '@trpc/server';
import { CaptureDeviceService } from '../services/capture-device.service.ts';

function response(value: unknown, status = 200) {
  return Response.json(value, { status, headers: { 'Cache-Control': 'no-store' } });
}

export async function handleCaptureRequest(
  request: Request,
  db: DbExecutor,
  kind: 'pair' | 'events',
  enabled: boolean,
) {
  if (!enabled) return response({ error: 'CAPTURE_DISABLED' }, 503);
  const service = new CaptureDeviceService(db);
  try {
    await service.takeIngress(kind);
    if (request.method !== 'POST') return response({ error: 'METHOD_NOT_ALLOWED' }, 405);
    if (request.headers.get('content-type')?.split(';')[0].trim() !== 'application/json')
      return response({ error: 'JSON_REQUIRED' }, 415);
    const limit = 65_536;
    if (Number(request.headers.get('content-length')) > limit)
      return response({ error: 'BODY_TOO_LARGE' }, 413);
    const reader = request.body?.getReader();
    if (!reader) return response({ error: 'INVALID_BODY' }, 400);
    const chunks: Uint8Array[] = [];
    let length = 0;
    try {
      while (true) {
        const part = await reader.read();
        if (part.done) break;
        length += part.value.byteLength;
        if (length > limit) {
          await reader.cancel();
          return response({ error: 'BODY_TOO_LARGE' }, 413);
        }
        chunks.push(part.value);
      }
    } finally {
      reader.releaseLock();
    }
    let body: unknown;
    try {
      body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    } catch {
      return response({ error: 'INVALID_BODY' }, 400);
    }
    if (kind === 'pair') return response(await service.pair(body, true));
    const authorization = request.headers.get('authorization');
    const token = /^Bearer ([A-Za-z0-9_-]{43})$/.exec(authorization ?? '')?.[1] ?? '';
    return response(await service.ingest(token, body, true));
  } catch (error) {
    if (error instanceof TRPCError) {
      const status = {
        UNAUTHORIZED: 401,
        TOO_MANY_REQUESTS: 429,
        BAD_REQUEST: 400,
        NOT_FOUND: 404,
        CONFLICT: 409,
      }[error.code as string];
      return response({ error: error.code }, status ?? 500);
    }
    return response({ error: 'CAPTURE_UNAVAILABLE' }, 503);
  }
}
