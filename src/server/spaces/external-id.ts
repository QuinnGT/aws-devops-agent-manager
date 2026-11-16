import { randomBytes } from "node:crypto";
import { AssumeRoleCommand, type STSClient } from "@aws-sdk/client-sts";
import { type Actor, baseStsClient, type SpaceAwsConfig, sourceIdentityFor } from "@/server/aws/clients";

/**
 * Per-space external ID for cross-account roles.
 * The app generates it; the space owner puts it in each role's trust policy.
 */

const EXTERNAL_ID_RE = /^dam-[0-9a-f]{48}$/;

/** 24 random bytes as hex with a "dam-" prefix: 52 characters, inside STS's [\w+=,.@:/-]{2,1224}. */
export function generateExternalId(): string {
  return `dam-${randomBytes(24).toString("hex")}`;
}

export function isGeneratedExternalId(value: string): boolean {
  return EXTERNAL_ID_RE.test(value);
}

/** Distinct role ARNs configured on a space. */
export function spaceRoleArns(space: Pick<SpaceAwsConfig, "readRoleArn" | "writeRoleArn">): string[] {
  return [...new Set([space.readRoleArn, space.writeRoleArn].filter((a): a is string => Boolean(a)))];
}

export type ExternalIdCheck =
  | { status: "skipped"; reason: "no-roles" | "no-external-id" }
  /** Every role refused AssumeRole without the external ID */
  | { status: "enforced"; roles: string[] }
  /** At least one role could be assumed without the external ID: registration must be rejected */
  | { status: "not-enforced"; roles: string[] }
  | { status: "error"; role: string; error: { name: string; message: string } };

function errorSummary(err: unknown): { name: string; message: string } {
  if (err instanceof Error) return { name: err.name, message: err.message.slice(0, 500) };
  return { name: "Error", message: String(err).slice(0, 500) };
}

/**
 * AWS recommends testing that a cross-account role can't be assumed without
 * the correct external ID. For each role on the space, call sts:AssumeRole
 * exactly as the app does (same source identity) but without ExternalId.
 * AccessDenied means the trust policy enforces the external ID. Success means
 * it does not, and any credentials returned are dropped immediately.
 *
 * Only meaningful when the space has role ARNs and an external ID, which is
 * how hosted mode reaches a space; local mode with a profile and no roles is
 * skipped.
 */
export async function checkExternalIdEnforced(
  space: SpaceAwsConfig,
  actor: Actor,
  sts: STSClient = baseStsClient(space),
): Promise<ExternalIdCheck> {
  const roles = spaceRoleArns(space);
  if (roles.length === 0) return { status: "skipped", reason: "no-roles" };
  if (!space.externalId) return { status: "skipped", reason: "no-external-id" };

  const assumable: string[] = [];
  for (const role of roles) {
    try {
      await sts.send(
        new AssumeRoleCommand({
          RoleArn: role,
          RoleSessionName: "dam-external-id-check",
          DurationSeconds: 900,
          SourceIdentity: sourceIdentityFor(actor),
        }),
      );
      assumable.push(role);
    } catch (err) {
      const name = err instanceof Error ? err.name : "";
      if (name === "AccessDenied" || name === "AccessDeniedException") continue;
      return { status: "error", role, error: errorSummary(err) };
    }
  }
  return assumable.length > 0 ? { status: "not-enforced", roles: assumable } : { status: "enforced", roles };
}
