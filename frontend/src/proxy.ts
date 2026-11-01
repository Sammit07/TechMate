import { NextResponse, type NextRequest } from "next/server"

// Optimistic sign-in check: no session cookie -> the sign-in page. The backend verifies the
// signed cookie on every /api request, so this only spares people a page full of errors.
// (The cookie is HttpOnly; with sign-in off the backend sets an "open" one.)
const SESSION_COOKIE = "techmate_session"

export function proxy(request: NextRequest) {
  if (request.cookies.has(SESSION_COOKIE)) return NextResponse.next()
  const url = request.nextUrl.clone()
  const next = `${request.nextUrl.pathname}${request.nextUrl.search}`
  url.pathname = "/login"
  url.search = next === "/" ? "" : `?next=${encodeURIComponent(next)}`
  return NextResponse.redirect(url)
}

export const config = {
  // Everything except the sign-in page, the API (protected by the backend) and static assets.
  matcher: ["/((?!api|login|_next/static|_next/image|favicon\\.ico|.*\\.(?:svg|png|jpg|jpeg|ico|webp)$).*)"],
}
