import { redirect } from "next/navigation";
import { getCurrentUser } from "@/server/auth/dal";
import { env } from "@/server/env";
import { SignInButton } from "./sign-in-button";

export default async function SignInPage() {
  if (await getCurrentUser()) redirect("/");
  const oidc = env().oidc;
  return (
    <main className="flex min-h-screen items-center justify-center p-6">
      <div className="w-full max-w-sm space-y-4 rounded-lg border p-6">
        <h1 className="text-xl font-semibold">DevOps Agent Manager</h1>
        {oidc ? (
          <SignInButton providerId={oidc.providerId} />
        ) : (
          <p className="text-sm text-muted-foreground">
            Sign-in is not configured, so the app rejects every request. Set OIDC_ISSUER, OIDC_CLIENT_ID and
            OIDC_CLIENT_SECRET_FILE, or for local use on 127.0.0.1 set AUTH_DEV_BYPASS=true.
          </p>
        )}
      </div>
    </main>
  );
}
