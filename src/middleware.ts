import { NextResponse } from 'next/server'
import type { NextRequest } from 'next/server'

export function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl

  // Skip API routes, static files, and public paths
  if (
    pathname.startsWith('/api/') ||
    pathname.startsWith('/_next/') ||
    pathname.startsWith('/favicon') ||
    pathname === '/'
  ) {
    return NextResponse.next()
  }

  // Protected routes: /dashboard, /settings, /history
  const protectedPaths = ['/dashboard', '/settings', '/history']
  const isProtected = protectedPaths.some(p => pathname.startsWith(p))

  if (isProtected) {
    const userId = request.cookies.get('caloriebot-user-id')
    if (!userId) {
      return NextResponse.redirect(new URL('/', request.url))
    }
  }

  return NextResponse.next()
}

export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico).*)'],
}
