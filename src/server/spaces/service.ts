import { eq } from "drizzle-orm";
import { recordAuditEvent } from "@/server/audit-log";
import type { Actor } from "@/server/aws/clients";
import { db } from "@/server/db/client";
import { agentSpaces, historyRepos } from "@/server/db/schema";
import { enqueue } from "@/server/jobs/enqueue";
import { requestSync } from "@/server/sync/contract";
import { SpaceServiceError, uniqueViolation } from "./errors";
import { generateExternalId, spaceRoleArns } from "./external-id";
import { insertHistoryRepo } from "./history-repos";
import { connectionTestJob } from "./jobs";
import { getSpaceById, type Space, type SpaceRow } from "./queries";
import { settingsDiff } from "./settings-form";
import { type SpaceSettings, spaceSettingsSchema } from "./settings-schema";
import { type RegisterSpaceInput, roleIssues, type UpdateSpaceInput } from "./validators";

/**
 * Space registration and edits. Callers (Server Actions) check permissions
 * with the DAL first; these functions take the acting user and record every
 * change in the audit log.
 */

function duplicateSpace(err: unknown, input: Pick<RegisterSpaceInput, "alias">): never {
  const constraint = uniqueViolation(err);
  if (constraint === null) throw err;
  if (constraint.includes("alias")) {
    throw new SpaceServiceError(`The alias ${input.alias} is taken.`, { alias: "This alias is taken." });
  }
  if (constraint.includes("space_uq")) {
    throw new SpaceServiceError("This Agent Space is already registered.", { agentSpaceId: "Already registered in this Region." });
  }
  if (constraint.includes("history_repos")) {
    throw new SpaceServiceError("A history repository with that name already exists.", { "historyRepo.repo.name": "This name is taken." });
  }
  throw new SpaceServiceError("A space or repository with these details already exists.");
}

/**
 * Register a space and, if asked, create its history repository in the same
 * transaction. Generates an external ID when role ARNs are given. The caller
 * starts the connection test (requestConnectionTest) afterwards.
 */
export async function registerSpace(input: RegisterSpaceInput, actor: Actor): Promise<SpaceRow> {
  const hasRoles = spaceRoleArns(input).length > 0;
  let createdRepo = false;
  let repoName = "";
  let row: SpaceRow;
  try {
    row = await db().transaction(async (tx) => {
      let repoId: string;
      if (input.historyRepo.mode === "new") {
        const repo = await insertHistoryRepo(input.historyRepo.repo, tx).catch((err: unknown) => {
          if (err instanceof SpaceServiceError) throw new SpaceServiceError(err.message, { "historyRepo.repo.name": "This name is taken." });
          throw err;
        });
        repoId = repo.id;
        repoName = repo.name;
        createdRepo = true;
      } else {
        const [repo] = await tx.select().from(historyRepos).where(eq(historyRepos.id, input.historyRepo.id));
        if (!repo) throw new SpaceServiceError("That history repository no longer exists.", { "historyRepo.id": "Choose another repository." });
        repoId = repo.id;
        repoName = repo.name;
      }
      const [space] = await tx
        .insert(agentSpaces)
        .values({
          alias: input.alias,
          displayName: input.displayName,
          region: input.region,
          accountId: input.accountId,
          agentSpaceId: input.agentSpaceId,
          readRoleArn: input.readRoleArn,
          writeRoleArn: input.writeRoleArn,
          externalId: hasRoles ? generateExternalId() : null,
          awsProfile: input.awsProfile,
          historyRepoId: repoId,
          settings: spaceSettingsSchema.parse({}),
        })
        .returning();
      return space!;
    });
  } catch (err) {
    if (err instanceof SpaceServiceError) throw err;
    duplicateSpace(err, input);
  }

  if (createdRepo) {
    const repo = input.historyRepo.mode === "new" ? input.historyRepo.repo : null;
    await recordAuditEvent({
      actor,
      action: "history-repo.create",
      targetType: "history_repo",
      targetId: row.historyRepoId ?? undefined,
      details: {
        name: repoName,
        remoteUrl: repo?.remoteUrl ?? null,
        deployKeyFile: repo?.deployKeyFile ?? null,
        defaultBranch: repo?.defaultBranch ?? "main",
        pushEnabled: repo?.pushEnabled ?? false,
      },
    });
  }
  await recordAuditEvent({
    actor,
    action: "space.register",
    spaceId: row.id,
    targetType: "agent_space",
    targetId: row.id,
    details: {
      alias: row.alias,
      region: row.region,
      accountId: row.accountId,
      agentSpaceId: row.agentSpaceId,
      readRoleArn: row.readRoleArn,
      writeRoleArn: row.writeRoleArn,
      awsProfile: row.awsProfile,
      externalIdGenerated: row.externalId !== null,
      historyRepo: repoName,
      historyRepoCreated: createdRepo,
    },
  });
  return row;
}

async function requireSpace(spaceId: string): Promise<Space> {
  const space = await getSpaceById(spaceId);
  if (!space) throw new SpaceServiceError("That space no longer exists.");
  return space;
}

/**
 * Change a space's display name, role ARNs or AWS profile. Alias, Region,
 * account, Agent Space ID and history repository are fixed after
 * registration. A change to how the app reaches AWS resets the connection
 * status until the next test. The external ID is generated the first time
 * roles are set and kept afterwards, so trust policies stay valid.
 */
export async function updateSpace(spaceId: string, input: UpdateSpaceInput, actor: Actor): Promise<SpaceRow> {
  const before = await requireSpace(spaceId);
  const issues = roleIssues(before.accountId, input);
  if (issues.length > 0) {
    throw new SpaceServiceError(issues[0]!.message, Object.fromEntries(issues.map((i) => [i.path, i.message])));
  }
  const hasRoles = spaceRoleArns(input).length > 0;
  const externalId = before.externalId ?? (hasRoles ? generateExternalId() : null);
  const accessChanged =
    before.readRoleArn !== input.readRoleArn || before.writeRoleArn !== input.writeRoleArn || before.awsProfile !== input.awsProfile;

  const [row] = await db()
    .update(agentSpaces)
    .set({
      displayName: input.displayName,
      readRoleArn: input.readRoleArn,
      writeRoleArn: input.writeRoleArn,
      awsProfile: input.awsProfile,
      externalId,
      ...(accessChanged ? { connectionStatus: "unknown", connectionDetail: null } : {}),
    })
    .where(eq(agentSpaces.id, spaceId))
    .returning();

  const changed: Record<string, { from: unknown; to: unknown }> = {};
  for (const k of ["displayName", "readRoleArn", "writeRoleArn", "awsProfile"] as const) {
    if (before[k] !== input[k]) changed[k] = { from: before[k], to: input[k] };
  }
  if (before.externalId === null && externalId !== null) changed.externalId = { from: null, to: "generated" };
  await recordAuditEvent({
    actor,
    action: "space.update",
    spaceId,
    targetType: "agent_space",
    targetId: spaceId,
    details: { alias: before.alias, changed },
  });
  return row!;
}

/** Replace a space's settings with an already validated value (see parseSettingsForm). */
export async function updateSpaceSettings(spaceId: string, settings: SpaceSettings, actor: Actor): Promise<SpaceSettings> {
  const before = await requireSpace(spaceId);
  const next = spaceSettingsSchema.parse(settings);
  await db().update(agentSpaces).set({ settings: next }).where(eq(agentSpaces.id, spaceId));
  await recordAuditEvent({
    actor,
    action: "space.settings-update",
    spaceId,
    targetType: "agent_space",
    targetId: spaceId,
    details: { alias: before.alias, changed: settingsDiff(before.parsedSettings, next) },
  });
  return next;
}

/** Enqueue spaces.connection-test. Returns the job_runs id for JobProgress. */
export async function requestConnectionTest(spaceId: string, actor: Actor, reason: "registration" | "manual" = "manual"): Promise<string> {
  const space = await requireSpace(spaceId);
  const runId = await enqueue(connectionTestJob, { spaceId, reason }, { actor, spaceId });
  await recordAuditEvent({
    actor,
    action: "space.connection-test-request",
    spaceId,
    targetType: "agent_space",
    targetId: spaceId,
    details: { alias: space.alias, reason, runId },
  });
  return runId;
}

/** Request a sync of the space (sync.run). Returns the job_runs id for JobProgress. */
export async function requestSpaceSync(spaceId: string, actor: Actor): Promise<string> {
  const space = await requireSpace(spaceId);
  const runId = await requestSync(spaceId, actor, "manual");
  await recordAuditEvent({
    actor,
    action: "sync.request",
    spaceId,
    targetType: "agent_space",
    targetId: spaceId,
    details: { alias: space.alias, reason: "manual", runId },
  });
  return runId;
}
