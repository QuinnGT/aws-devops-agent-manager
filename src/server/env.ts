import { readFileSync } from "node:fs";
import path from "node:path";
import { z } from "zod";

/**
 * Bootstrap settings only. Everything else is policy (src/server/policy) or
 * per-space settings in Postgres. Secrets come from `*_FILE` paths or from an
 * environment variable injected by the runtime (compose `${VAR:?}`), never from
 * a committed file.
 */

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "::1", "localhost"]);

const boolish = z
  .enum(["true", "false", "1", "0", ""])
  .optional()
  .transform((v) => v === "true" || v === "1");

const raw = z.object({
  DATABASE_URL: z.string().optional(),
  DATABASE_URL_FILE: z.string().optional(),
  DAM_HOST: z.string().default("127.0.0.1"),
  PORT: z.coerce.number().int().positive().default(3000),
  DAM_LOOPBACK_PUBLISH_ONLY: boolish,
  DAM_PROCESS: z.enum(["web", "worker"]).default("web"),
  DAM_DATA_DIR: z.string().default("./data"),
  DAM_POLICY_DIR: z.string().default("./policy"),
  DAM_POLICY_OVERLAY_DIRS: z.string().default(""),
  DAM_ALLOWED_ORIGINS: z.string().default(""),
  AUTH_DEV_BYPASS: boolish,
  AUTH_DEV_USER_EMAIL: z.string().default("local@localhost"),
  AUTH_DEV_USER_NAME: z.string().default("Local user"),
  AUTH_DEV_ROLE: z.enum(["viewer", "editor", "publisher", "admin"]).default("admin"),
  BETTER_AUTH_URL: z.string().optional(),
  BETTER_AUTH_SECRET: z.string().optional(),
  BETTER_AUTH_SECRET_FILE: z.string().optional(),
  OIDC_PROVIDER_ID: z.string().default("oidc"),
  OIDC_ISSUER: z.string().optional(),
  OIDC_CLIENT_ID: z.string().optional(),
  OIDC_CLIENT_SECRET: z.string().optional(),
  OIDC_CLIENT_SECRET_FILE: z.string().optional(),
  OIDC_GROUPS_CLAIM: z.string().default("groups"),
});

export type Env = ReturnType<typeof buildEnv>;

function readSecret(literal: string | undefined, file: string | undefined): string | undefined {
  if (file) return readFileSync(file, "utf8").trim();
  return literal || undefined;
}

function buildEnv(source: NodeJS.ProcessEnv) {
  const e = raw.parse(source);
  const oidcClientSecret = readSecret(e.OIDC_CLIENT_SECRET, e.OIDC_CLIENT_SECRET_FILE);
  const oidcConfigured = Boolean(e.OIDC_ISSUER && e.OIDC_CLIENT_ID && oidcClientSecret);
  return {
    databaseUrl: () => {
      const url = readSecret(e.DATABASE_URL, e.DATABASE_URL_FILE);
      if (!url) throw new Error("DATABASE_URL or DATABASE_URL_FILE must be set");
      return url;
    },
    host: e.DAM_HOST,
    port: e.PORT,
    hostIsLoopback: LOOPBACK_HOSTS.has(e.DAM_HOST),
    loopbackPublishOnly: e.DAM_LOOPBACK_PUBLISH_ONLY,
    process: e.DAM_PROCESS,
    dataDir: path.resolve(e.DAM_DATA_DIR),
    policyDir: path.resolve(e.DAM_POLICY_DIR),
    // Directories merged over policyDir, lowest precedence first (see src/server/policy/loader.ts).
    policyOverlayDirs: e.DAM_POLICY_OVERLAY_DIRS.split(path.delimiter).map((s) => s.trim()).filter(Boolean).map((s) => path.resolve(s)),
    allowedOrigins: e.DAM_ALLOWED_ORIGINS.split(",").map((s) => s.trim()).filter(Boolean),
    devBypass: e.AUTH_DEV_BYPASS,
    devUser: { email: e.AUTH_DEV_USER_EMAIL, name: e.AUTH_DEV_USER_NAME, role: e.AUTH_DEV_ROLE },
    betterAuthUrl: e.BETTER_AUTH_URL,
    betterAuthSecret: () => readSecret(e.BETTER_AUTH_SECRET, e.BETTER_AUTH_SECRET_FILE),
    oidc: oidcConfigured
      ? {
          providerId: e.OIDC_PROVIDER_ID,
          issuer: e.OIDC_ISSUER!,
          clientId: e.OIDC_CLIENT_ID!,
          clientSecret: oidcClientSecret!,
          groupsClaim: e.OIDC_GROUPS_CLAIM,
        }
      : null,
  };
}

let cached: Env | undefined;

/** Parsed bootstrap environment. Lazy so that importing a module never throws. */
export function env(): Env {
  cached ??= buildEnv(process.env);
  return cached;
}

/** Tests only: rebuild from a custom environment. */
export function resetEnvForTests(source?: NodeJS.ProcessEnv): void {
  cached = source ? buildEnv(source) : undefined;
}

/**
 * Refuse unsafe startup combinations. Called by src/instrumentation.ts (web)
 * and src/worker/index.ts (worker).
 *
 * The dev sign-in bypass is allowed only when the server binds loopback, or
 * when it runs in a container whose port is published to 127.0.0.1 only
 * (compose.yaml sets DAM_LOOPBACK_PUBLISH_ONLY=true next to that mapping).
 */
export function assertSafeStartup(e: Env = env()): void {
  if (e.devBypass && !e.hostIsLoopback && !e.loopbackPublishOnly) {
    throw new Error(
      `AUTH_DEV_BYPASS is on but DAM_HOST is ${e.host}. The bypass is allowed only on 127.0.0.1, ` +
        "or in a container published to 127.0.0.1 only (DAM_LOOPBACK_PUBLISH_ONLY=true).",
    );
  }
  if (!e.devBypass && e.oidc && !e.betterAuthSecret()) {
    throw new Error("OIDC is configured but BETTER_AUTH_SECRET_FILE (or BETTER_AUTH_SECRET) is not set.");
  }
}
