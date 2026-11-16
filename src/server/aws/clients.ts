import { CloudTrailClient } from "@aws-sdk/client-cloudtrail";
import { DevOpsAgentClient } from "@aws-sdk/client-devops-agent";
import { STSClient } from "@aws-sdk/client-sts";
import { fromIni, fromNodeProviderChain, fromTemporaryCredentials } from "@aws-sdk/credential-providers";
import type { AwsCredentialIdentityProvider } from "@smithy/types";
import { env } from "@/server/env";
import { getAppPolicy } from "@/server/policy";

/**
 * AWS access for one registered Agent Space.
 *
 * - Base identity: the SDK default credential chain (profile, SSO, env vars,
 *   task/pod role). AWS_PROFILE is honored but not required. A space may name
 *   a profile for local mode.
 * - If the space has role ARNs, the read role is assumed for browsing, sync
 *   and exports, and the write role only inside worker jobs.
 * - The acting app user is set as the STS source identity.
 * - The app never stores access keys.
 */

export interface SpaceAwsConfig {
  id: string;
  alias: string;
  region: string;
  accountId: string;
  agentSpaceId: string;
  readRoleArn: string | null;
  writeRoleArn: string | null;
  externalId: string | null;
  awsProfile: string | null;
}

export interface Actor {
  /** App user's email, or "system:<job>" for scheduled work */
  email: string;
}

export type AccessMode = "read" | "write";

export class WriteAccessError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WriteAccessError";
  }
}

function baseCredentials(space: SpaceAwsConfig): AwsCredentialIdentityProvider {
  return space.awsProfile ? fromIni({ profile: space.awsProfile }) : fromNodeProviderChain();
}

/** STS source identity: 2-64 chars of [\w+=,.@-]. Comes from the session, never from request input. */
export function sourceIdentityFor(actor: Actor): string {
  const cleaned = actor.email.replace(/[^\w+=,.@-]/g, "-").slice(0, 64);
  return cleaned.length >= 2 ? cleaned : `dam-${cleaned}`.slice(0, 64);
}

function roleSessionName(mode: AccessMode, actor: Actor): string {
  return `dam-${mode}-${actor.email.replace(/[^\w+=,.@-]/g, "-")}`.slice(0, 64);
}

const providerCache = new Map<string, { provider: AwsCredentialIdentityProvider; created: number }>();

export function spaceCredentials(space: SpaceAwsConfig, mode: AccessMode, actor: Actor): AwsCredentialIdentityProvider {
  if (mode === "write" && env().process !== "worker") {
    throw new WriteAccessError("Write access to an Agent Space is allowed only inside worker jobs.");
  }
  const roleArn = mode === "write" ? space.writeRoleArn : space.readRoleArn;
  if (!roleArn) return baseCredentials(space);

  const key = `${space.id}|${mode}|${actor.email}|${roleArn}`;
  const sessionSeconds = getAppPolicy().policy.api.roleSessionSeconds;
  const hit = providerCache.get(key);
  if (hit && Date.now() - hit.created < (sessionSeconds - 300) * 1000) return hit.provider;

  const provider = fromTemporaryCredentials({
    masterCredentials: baseCredentials(space),
    params: {
      RoleArn: roleArn,
      RoleSessionName: roleSessionName(mode, actor),
      DurationSeconds: sessionSeconds,
      SourceIdentity: sourceIdentityFor(actor),
      ...(space.externalId ? { ExternalId: space.externalId } : {}),
    },
    clientConfig: { region: space.region },
  });
  providerCache.set(key, { provider, created: Date.now() });
  return provider;
}

function retryConfig() {
  return { retryMode: "adaptive" as const, maxAttempts: getAppPolicy().policy.api.maxAttempts };
}

export function devOpsAgentClient(space: SpaceAwsConfig, mode: AccessMode, actor: Actor): DevOpsAgentClient {
  return new DevOpsAgentClient({
    region: space.region,
    credentials: spaceCredentials(space, mode, actor),
    ...retryConfig(),
  });
}

/**
 * STS with the base identity only (no space role assumed). Used to check that
 * a space role refuses AssumeRole without its external ID; callers discard any
 * credentials it returns.
 */
export function baseStsClient(space: SpaceAwsConfig): STSClient {
  return new STSClient({ region: space.region, credentials: baseCredentials(space), ...retryConfig() });
}

/** CloudTrail is always read-only for this app and uses the read role. */
export function cloudTrailClient(space: SpaceAwsConfig, actor: Actor): CloudTrailClient {
  return new CloudTrailClient({
    region: space.region,
    credentials: spaceCredentials(space, "read", actor),
    ...retryConfig(),
  });
}

/** Credentials for Bedrock (AI SDK `credentialProvider`), through the space's read role by default. */
export function bedrockCredentials(space: SpaceAwsConfig, actor: Actor): AwsCredentialIdentityProvider {
  return spaceCredentials(space, "read", actor);
}

export function resetAwsCachesForTests(): void {
  providerCache.clear();
}
