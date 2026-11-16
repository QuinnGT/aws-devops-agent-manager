import { z } from "zod";

/**
 * Input validation for space registration, space edits, history repositories
 * and role bindings. Pure and shared by Server Actions and service functions.
 * Optional text fields arrive from forms as "" and are normalized to null.
 */

/** Aliases that would collide with routes under /spaces. */
export const RESERVED_ALIASES: readonly string[] = ["new"];

const ALIAS_RE = /^[a-z0-9][a-z0-9-]{1,38}[a-z0-9]$/;
const REGION_RE = /^[a-z]{2}(?:-[a-z]+)+-\d{1,2}$/;
const ACCOUNT_RE = /^\d{12}$/;
const AGENT_SPACE_ID_RE = /^[A-Za-z0-9][A-Za-z0-9-]{0,127}$/;
const ROLE_ARN_RE =
  /^arn:aws(?:-cn|-us-gov|-iso|-iso-[a-z])?:iam::(\d{12}):role\/(?:[\w+=,.@-]+\/)*[\w+=,.@-]{1,64}$/;
const PROFILE_RE = /^[A-Za-z0-9][A-Za-z0-9_.+@-]{0,63}$/;
const ACCESS_KEY_RE = /^(?:AKIA|ASIA|ABIA|ACCA)[A-Z0-9]{12,}$/;
const REPO_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;
const SCP_REMOTE_RE = /^[A-Za-z0-9._-]+@[A-Za-z0-9.-]+:[A-Za-z0-9._~/-]+$/;
const GROUP_RE = /^[^\p{Cc}]{1,256}$/u;

/** "" or whitespace becomes null; other strings are trimmed. */
function blankToNull(v: unknown): unknown {
  if (typeof v !== "string") return v ?? null;
  const t = v.trim();
  return t === "" ? null : t;
}

function trimmed(v: unknown): unknown {
  return typeof v === "string" ? v.trim() : v;
}

/** Wrap a string schema so a blank value is null. */
function optionalText<S extends z.ZodType<string>>(schema: S) {
  return z.preprocess(blankToNull, schema.nullable());
}

/** Checkbox values from FormData ("on", "true") or booleans. */
export const checkbox = z.preprocess((v) => v === true || v === "on" || v === "true" || v === "1", z.boolean());

export const aliasSchema = z.preprocess(
  trimmed,
  z
    .string()
    .regex(ALIAS_RE, "Use 3 to 40 lowercase letters, digits or hyphens, starting and ending with a letter or digit.")
    .refine((a) => !RESERVED_ALIASES.includes(a), "This alias is reserved. Choose another."),
);

export const displayNameSchema = optionalText(z.string().max(100, "Use at most 100 characters."));

export const regionSchema = z.preprocess(trimmed, z.string().regex(REGION_RE, "Enter a Region code such as us-west-2."));

export const accountIdSchema = z.preprocess(trimmed, z.string().regex(ACCOUNT_RE, "Enter the 12-digit AWS account ID."));

export const agentSpaceIdSchema = z.preprocess(
  trimmed,
  z.string().regex(AGENT_SPACE_ID_RE, "Enter the Agent Space ID shown in the DevOps Agent console."),
);

export const roleArnSchema = z
  .string()
  .regex(ROLE_ARN_RE, "Enter an IAM role ARN such as arn:aws:iam::111122223333:role/DevOpsAgentManagerRead.");

export const optionalRoleArnSchema = optionalText(roleArnSchema);

/** A named AWS profile for local mode. Only a name: anything shaped like an access key is rejected. */
export const awsProfileSchema = optionalText(
  z
    .string()
    .regex(PROFILE_RE, "Use a profile name from your AWS config: letters, digits and _ . + @ -.")
    .refine((p) => !ACCESS_KEY_RE.test(p), "Enter a profile name, not an access key. The app never stores credentials."),
);

/** The account in an IAM role ARN, or null when the ARN does not parse. */
export function roleArnAccount(arn: string): string | null {
  return ROLE_ARN_RE.exec(arn)?.[1] ?? null;
}

export const historyRepoNameSchema = z.preprocess(
  trimmed,
  z
    .string()
    .regex(REPO_NAME_RE, "Use up to 100 letters, digits, dots, hyphens or underscores.")
    .refine((n) => n !== "." && n !== "..", "Choose another name."),
);

/** True for https:// or ssh:// URLs without embedded passwords or tokens, and scp-style git@host:path. */
export function isAllowedRemoteUrl(value: string): boolean {
  if (SCP_REMOTE_RE.test(value)) return true;
  let u: URL;
  try {
    u = new URL(value);
  } catch {
    return false;
  }
  if (u.search || u.hash || u.password) return false;
  if (u.protocol === "https:") return u.username === "" && u.pathname.length > 1;
  if (u.protocol === "ssh:") return u.pathname.length > 1;
  return false;
}

export const remoteUrlSchema = optionalText(
  z
    .string()
    .max(500)
    .refine(isAllowedRemoteUrl, "Use an https:// or ssh:// URL, or git@host:owner/repo.git, with no token or password in it."),
);

/** A path to a deploy key file the worker can read. Never the key itself. */
export const deployKeyFileSchema = optionalText(
  z
    .string()
    .max(1024)
    .refine((p) => p.startsWith("/"), "Enter an absolute path to the key file, such as /run/secrets/history_deploy_key.")
    .refine((p) => !/[\0\r\n]/.test(p), "The path must be on one line.")
    .refine((p) => !p.split("/").includes(".."), "The path must not contain .. segments.")
    .refine((p) => !/BEGIN|PRIVATE KEY/.test(p), "Enter the path to the key file, not the key."),
);

/**
 * A branch name git accepts (git check-ref-format --branch), limited to
 * letters, digits and . _ / -: no "..", no "//", no component starting with
 * "." or ending in ".lock", and no leading "-" or trailing "/" or ".".
 */
export function isValidBranchName(name: string): boolean {
  if (name.length > 100 || !/^[A-Za-z0-9._/-]+$/.test(name)) return false;
  if (name.startsWith("-") || name.startsWith("/") || name.endsWith("/") || name.endsWith(".")) return false;
  if (name.includes("..") || name.includes("//")) return false;
  return name.split("/").every((part) => !part.startsWith(".") && !part.endsWith(".lock"));
}

/** The branch the history is committed to and pushed from. Blank means "main". */
export const branchSchema = z.preprocess(
  (v) => blankToNull(v) ?? "main",
  z.string().refine(isValidBranchName, "Use a branch name such as main or history/test: letters, digits, dots, hyphens, underscores and slashes, with no .. and no / or . at the end."),
);

export const historyRepoFieldsSchema = z
  .object({
    name: historyRepoNameSchema,
    remoteUrl: remoteUrlSchema,
    deployKeyFile: deployKeyFileSchema,
    defaultBranch: branchSchema,
    pushEnabled: checkbox.default(false),
  })
  .superRefine((r, ctx) => {
    if (r.pushEnabled && !r.remoteUrl) {
      ctx.addIssue({ code: "custom", path: ["remoteUrl"], message: "Pushing needs a remote URL." });
    }
    if (r.pushEnabled && !r.deployKeyFile) {
      ctx.addIssue({ code: "custom", path: ["deployKeyFile"], message: "Pushing needs a deploy key file path." });
    }
  });

export type HistoryRepoFields = z.output<typeof historyRepoFieldsSchema>;

/** Fields an Admin can change on a registered space. */
const connectionFields = {
  displayName: displayNameSchema,
  readRoleArn: optionalRoleArnSchema,
  writeRoleArn: optionalRoleArnSchema,
  awsProfile: awsProfileSchema,
};

interface RoleFields {
  readRoleArn: string | null;
  writeRoleArn: string | null;
}

/** Role ARNs must be in the space's account, and a write role needs a read role. */
export function roleIssues(accountId: string, r: RoleFields): { path: "readRoleArn" | "writeRoleArn"; message: string }[] {
  const issues: { path: "readRoleArn" | "writeRoleArn"; message: string }[] = [];
  for (const key of ["readRoleArn", "writeRoleArn"] as const) {
    const arn = r[key];
    if (arn && roleArnAccount(arn) !== accountId) {
      issues.push({ path: key, message: `The role must be in the space's account (${accountId}).` });
    }
  }
  if (r.writeRoleArn && !r.readRoleArn) {
    issues.push({ path: "readRoleArn", message: "Add a read role ARN when you set a write role ARN." });
  }
  return issues;
}

export const historyRepoChoiceSchema = z.discriminatedUnion("mode", [
  z.object({ mode: z.literal("existing"), id: z.uuid("Choose a history repository.") }),
  z.object({ mode: z.literal("new"), repo: historyRepoFieldsSchema }),
]);

export const registerSpaceSchema = z
  .object({
    alias: aliasSchema,
    region: regionSchema,
    accountId: accountIdSchema,
    agentSpaceId: agentSpaceIdSchema,
    ...connectionFields,
    historyRepo: historyRepoChoiceSchema,
  })
  .superRefine((s, ctx) => {
    for (const i of roleIssues(s.accountId, s)) ctx.addIssue({ code: "custom", path: [i.path], message: i.message });
  });

export type RegisterSpaceInput = z.output<typeof registerSpaceSchema>;

/** Account-independent checks; the service adds roleIssues() against the stored account ID. */
export const updateSpaceSchema = z.object(connectionFields);

export type UpdateSpaceInput = z.output<typeof updateSpaceSchema>;

export const bindingSubjectTypeSchema = z.enum(["user", "group"]);

export const bindingInputSchema = z
  .object({
    spaceId: z.preprocess(blankToNull, z.uuid().nullable()),
    subjectType: bindingSubjectTypeSchema,
    subject: z.preprocess(trimmed, z.string().min(1, "Enter a user email or an IdP group name.")),
    role: z.preprocess(trimmed, z.string().min(1, "Choose a role.")),
  })
  .transform((b, ctx) => {
    if (b.subjectType === "user") {
      const email = z.email().safeParse(b.subject);
      if (!email.success) {
        ctx.addIssue({ code: "custom", path: ["subject"], message: "Enter a valid email address." });
        return z.NEVER;
      }
      return { ...b, subject: b.subject.toLowerCase() };
    }
    if (!GROUP_RE.test(b.subject)) {
      ctx.addIssue({ code: "custom", path: ["subject"], message: "Enter a group name of at most 256 characters." });
      return z.NEVER;
    }
    return b;
  });

export type BindingInput = z.output<typeof bindingInputSchema>;

/** Flatten Zod issues into { "a.b": "message" } for form display (first message per field). */
export function fieldErrors(error: z.ZodError): Record<string, string> {
  const out: Record<string, string> = {};
  for (const issue of error.issues) {
    const key = issue.path.map(String).join(".") || "_form";
    out[key] ??= issue.message;
  }
  return out;
}
