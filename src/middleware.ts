import { NextResponse } from 'next/server'
import type { NextRequest } from 'next/server'

export function middleware(request: NextRequest) {
  // Check for auth cookie/session
  // For MVP: check for a simple cookie 'caloriebot-user-id'
  // (Set by the verify OTP route on success)
  const userId = request.cookies.get('caloriebot-user-id')
  if (!userId) {
    return NextResponse.redirect(new URL('/', request.url))
  }
  return NextResponse.next()
}

export const config = {
  matcher: ['/(auth)/:path*'],
}
