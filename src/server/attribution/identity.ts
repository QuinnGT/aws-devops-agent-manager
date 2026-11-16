/**
 * Map a CloudTrail `userIdentity` to the principal fields attribution records.
 * Pure; reusable by any module that reads CloudTrail events.
 *
 * CloudTrail userIdentity reference:
 * https://docs.aws.amazon.com/awscloudtrail/latest/userguide/cloudtrail-event-reference-user-identity.html
 */

export interface PrincipalInfo {
  /** IAM principal ARN when there is one, otherwise the best available identifier */
  principal: string | null;
  /** Role session name (assumed roles) or federated user name */
  sessionName: string | null;
  /** Role name without path (assumed roles) */
  roleName: string | null;
}

function str(v: unknown): string | null {
  return typeof v === "string" && v.length > 0 ? v : null;
}

function obj(v: unknown): Record<string, unknown> | null {
  return typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

/** arn:aws:sts::<account>:assumed-role/<role-name>/<session-name> (no role path in this form) */
const ASSUMED_ROLE_ARN = /^arn:[^:]+:sts::[^:]*:assumed-role\/([^/]+)\/(.+)$/;
/** arn:aws:sts::<account>:federated-user/<name> */
const FEDERATED_USER_ARN = /^arn:[^:]+:sts::[^:]*:federated-user\/(.+)$/;
/** arn:aws:iam::<account>:role/<optional path/>role-name */
const IAM_ROLE_ARN = /^arn:[^:]+:iam::[^:]*:role\/(?:.*\/)?([^/]+)$/;

export function principalFromUserIdentity(userIdentity: unknown): PrincipalInfo {
  const ui = obj(userIdentity);
  if (!ui) return { principal: null, sessionName: null, roleName: null };

  const arn = str(ui.arn);
  const issuer = obj(obj(ui.sessionContext)?.sessionIssuer);
  const issuerArn = str(issuer?.arn);

  let sessionName: string | null = null;
  let roleName: string | null = null;

  const assumed = arn ? ASSUMED_ROLE_ARN.exec(arn) : null;
  const federated = arn ? FEDERATED_USER_ARN.exec(arn) : null;
  if (assumed) {
    roleName = assumed[1] ?? null;
    sessionName = assumed[2] ?? null;
  } else if (federated) {
    sessionName = federated[1] ?? null;
  }

  if (str(ui.type) === "AssumedRole") {
    // sessionIssuer.arn is normally the IAM role ARN; fall back to it, then to its userName.
    roleName ??= (issuerArn ? IAM_ROLE_ARN.exec(issuerArn)?.[1] : undefined) ?? str(issuer?.userName);
    // principalId is "<role id>:<session name>"
    const principalId = str(ui.principalId);
    if (!sessionName && principalId?.includes(":")) sessionName = principalId.slice(principalId.indexOf(":") + 1) || null;
  }

  const principal = arn ?? issuerArn ?? str(ui.invokedBy) ?? str(ui.principalId) ?? str(ui.userName) ?? str(ui.type);
  return { principal, sessionName, roleName };
}
