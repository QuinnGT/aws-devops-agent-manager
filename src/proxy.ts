import { NextResponse, type NextRequest } from "next/server";
import { getSessionCookie } from "better-auth/cookies";

/**
 * Redirects signed-out users to /sign-in. This is a convenience, not the
 * authorization check: every Server Action and Route Handler calls the DAL.
 */
export function proxy(req: NextRequest) {
  const bypass = process.env.AUTH_DEV_BYPASS;
  if (bypass === "true" || bypass === "1") return NextResponse.next();
  if (getSessionCookie(req)) return NextResponse.next();
  if (req.nextUrl.pathname.startsWith("/api/")) {
    return NextResponse.json({ error: "Not signed in" }, { status: 401 });
  }
  const url = req.nextUrl.clone();
  url.pathname = "/sign-in";
  url.search = "";
  return NextResponse.redirect(url);
}

export const config = {
  // The package upload (api/spaces/<alias>/packages/import) is left out: when
  // proxy runs, Next.js buffers the request body and silently cuts it at
  // experimental.proxyClientMaxBodySize (10 MB by default), which is below the
  // package caps. Its Route Handler checks the session itself (DAL) before
  // reading the body, and refuses larger or cut-off bodies with 413.
  matcher: ["/((?!sign-in|api/auth|api/spaces/[^/]+/packages/import|_next/static|_next/image|favicon.ico).*)"],
};
