import { toNextJsHandler } from "better-auth/next-js";
import { auth } from "@/server/auth/better-auth";

// Fails closed: with no IdP configured, every auth route returns 404.
const notConfigured = () => Response.json({ error: "Sign-in is not configured" }, { status: 404 });

export async function GET(req: Request) {
  const a = auth();
  return a ? toNextJsHandler(a).GET(req) : notConfigured();
}

export async function POST(req: Request) {
  const a = auth();
  return a ? toNextJsHandler(a).POST(req) : notConfigured();
}
