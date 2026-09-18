import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';

// Single-user gate. Everything behind it is private case material,
// so the app refuses to serve anything until APP_PASSWORD is set.
export function middleware(req: NextRequest) {
  const { pathname } = req.nextUrl;
  if (pathname.startsWith('/login') || pathname.startsWith('/api/login')) {
    return NextResponse.next();
  }
  const expected = process.env.APP_PASSWORD;
  if (!expected) {
    return new NextResponse('APP_PASSWORD is not set on the server.', { status: 503 });
  }
  if (req.cookies.get('cf_session')?.value === expected) {
    return NextResponse.next();
  }
  if (pathname.startsWith('/api/')) {
    return NextResponse.json({ error: 'Not signed in' }, { status: 401 });
  }
  return NextResponse.redirect(new URL('/login', req.url));
}

export const config = { matcher: ['/((?!_next/static|_next/image|favicon.ico).*)'] };

