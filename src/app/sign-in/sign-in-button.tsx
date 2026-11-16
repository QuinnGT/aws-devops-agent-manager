"use client";

import { createAuthClient } from "better-auth/react";
import { useState } from "react";
import { Button } from "@/components/ui/button";

// Better Auth 1.7 registers Generic OAuth providers as social providers,
// so sign-in goes through the standard signIn.social call.
const authClient = createAuthClient();

export function SignInButton({ providerId }: { providerId: string }) {
  const [busy, setBusy] = useState(false);
  return (
    <Button
      className="w-full"
      disabled={busy}
      onClick={async () => {
        setBusy(true);
        await authClient.signIn.social({ provider: providerId, callbackURL: "/" });
      }}
    >
      Sign in with SSO
    </Button>
  );
}
