/** Startup checks for the web server (Next.js calls register() once per server). */
export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  const { assertSafeStartup } = await import("@/server/env");
  const { getAppPolicy } = await import("@/server/policy");
  assertSafeStartup();
  getAppPolicy();
}
