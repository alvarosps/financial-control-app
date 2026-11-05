import { type NextRequest, NextResponse } from 'next/server';

export function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl;

  if (
    pathname.startsWith('/_next') ||
    pathname.startsWith('/favicon') ||
    pathname.startsWith('/api/trpc') ||
    pathname === '/api/capture/pair' ||
    pathname === '/api/capture/events' ||
    pathname === '/api/integrations/pluggy/webhook' ||
    pathname === '/api/cron/integrations' ||
    pathname.startsWith('/icons') ||
    pathname === '/manifest.webmanifest' ||
    pathname === '/robots.txt' ||
    pathname === '/sitemap.xml'
  ) {
    return NextResponse.next();
  }

  const publicPaths = ['/login', '/register', '/api/auth'];
  const isPublicPath = publicPaths.some((p) => pathname.startsWith(p));

  const sessionToken = request.cookies
    .getAll()
    .find((c) => c.name.includes('better-auth.session_token'))?.value;
  const hasSession = !!sessionToken;

  if (!hasSession && !isPublicPath) {
    return NextResponse.redirect(new URL('/login', request.url));
  }

  if (hasSession && isPublicPath && !pathname.startsWith('/api')) {
    return NextResponse.redirect(new URL('/dashboard', request.url));
  }

  return NextResponse.next();
}

export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico).*)'],
};
