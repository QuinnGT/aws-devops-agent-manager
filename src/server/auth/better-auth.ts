import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { nextCookies } from "better-auth/next-js";
import { genericOAuth } from "better-auth/plugins/generic-oauth";
import { db } from "@/server/db/client";
import { account, session, user, verification } from "@/server/db/schema";
import { env } from "@/server/env";

/**
 * Better Auth with one OIDC provider through the Generic OAuth plugin
 * (Okta, IAM Identity Center, Cognito, ...). Email/password is off.
 * Returns null when no IdP is configured: the app then fails closed.
 */
function build() {
  const e = env();
  if (!e.oidc) return null;
  const oidc = e.oidc;
  return betterAuth({
    secret: e.betterAuthSecret(),
    baseURL: e.betterAuthUrl,
    database: drizzleAdapter(db(), { provider: "pg", schema: { user, session, account, verification } }),
    emailAndPassword: { enabled: false },
    telemetry: { enabled: false },
    trustedOrigins: e.allowedOrigins,
    user: {
      additionalFields: {
        idpGroups: { type: "string", required: false, input: false },
      },
    },
    plugins: [
      genericOAuth({
        config: [
          {
            providerId: oidc.providerId,
            clientId: oidc.clientId,
            clientSecret: oidc.clientSecret,
            discoveryUrl: `${oidc.issuer.replace(/\/$/, "")}/.well-known/openid-configuration`,
            scopes: ["openid", "email", "profile"],
            pkce: true,
            mapProfileToUser: (profile) => {
              const groups = (profile as Record<string, unknown>)[oidc.groupsClaim];
              return { idpGroups: JSON.stringify(Array.isArray(groups) ? groups.map(String) : []) };
            },
          },
        ],
      }),
      nextCookies(),
    ],
  });
}

type Auth = NonNullable<ReturnType<typeof build>>;
const g = globalThis as unknown as { __damAuth?: Auth | null };

export function auth(): Auth | null {
  if (g.__damAuth === undefined) g.__damAuth = build();
  return g.__damAuth;
}
