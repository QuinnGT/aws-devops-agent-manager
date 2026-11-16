import { and, desc, eq, inArray, type SQL, sql } from "drizzle-orm";
import { z } from "zod";
import type { AssetSnapshot } from "@/lib/assets/types";
import { recordAuditEvent } from "@/server/audit-log";
import { openSpaceHistoryRepo, readCommittedAsset } from "@/server/assets/repo";
import { devOpsAgentClient } from "@/server/aws/clients";
import { db } from "@/server/db/client";
import { assetIndex, drafts } from "@/server/db/schema";
import { assetDisplayName } from "@/server/history/layout";
import type { DesiredAsset, DesiredFile } from "@/server/packages/types";
import type { Policy } from "@/server/policy";
import type { LiveReader } from "@/server/plans/check";
import { desiredContentHash, sameValue, snapshotContentHash } from "@/server/plans/content";
import { createPlanInternal } from "@/server/plans/create";
import { IdentityIndex } from "@/server/plans/resolve";
import { loadLiveIndex, policyForSpace, spaceReader } from "@/server/plans/runtime";
import { requestCheck } from "@/server/plans/service";
import { OPEN_STATES } from "@/server/plans/states";
import { dbPlanStore } from "@/server/plans/store";
import { plainErrorOf } from "@/server/jobs/error-text";
import { hasPermission, type DraftRow, type PlanActor, PlanServiceError } from "@/server/plans/types";
import { getSpaceById, type Space, toAwsConfig } from "@/server/spaces/queries";
import { assetIdentity } from "@/server/validation/identity";
import { validateAssetSet } from "@/server/validation/set";
import type { ValidationResult } from "@/server/validation/types";
import { validateDraftAsset } from "@/server/validation/asset";
import { editRulesFor, editViolations, type EditRules, isManagedAsset } from "./rules";

/**
 * Drafts: edits are saved as drafts in the app and do not touch the space
 * until a plan is applied. Service
 * functions behind the editor's Server Actions; each takes the acting user
 * with their permissions in the space. The Server Action checks
 * `drafts.write` (or `plans.create` for createPlanFromDrafts) with the DAL
 * first.
 */

export type DraftActor = PlanActor;

const ADMIN = "spaces.manage" as const;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function spaceOrThrow(spaceId: string): Promise<Space> {
  const space = await getSpaceById(spaceId);
  if (!space) throw new PlanServiceError("Space not found.", {}, 404);
  return space;
}

async function draftOrThrow(spaceId: string, draftId: string): Promise<DraftRow> {
  if (!UUID_RE.test(draftId)) throw new PlanServiceError("Draft not found.", {}, 404);
  const [row] = await db().select().from(drafts).where(and(eq(drafts.id, draftId), eq(drafts.spaceId, spaceId)));
  if (!row) throw new PlanServiceError("Draft not found.", {}, 404);
  return row;
}

function sameUser(a: string, b: string): boolean {
  return a.trim().toLowerCase() === b.trim().toLowerCase();
}

/** Asset IDs by name for the space's live assets, plus a name lookup for managed checks. */
async function liveContext(spaceId: string) {
  const live = await loadLiveIndex(spaceId);
  return { live, nameOf: (type: string, id: string) => live.find((a) => a.assetId === id && a.assetType === type)?.name };
}

/** A live or committed version as a DesiredAsset, with name references for every asset ID reference. */
export function desiredFromSnapshot(policy: Pick<Policy, "assetTypes">, snap: Pick<AssetSnapshot, "assetId" | "assetType" | "metadata" | "files">, index: IdentityIndex): DesiredAsset {
  const entry = policy.assetTypes.assetTypes[snap.assetType];
  const refs: Record<string, string | string[]> = {};
  for (const rule of entry?.references ?? []) {
    const v = snap.metadata[rule.key];
    const ids = typeof v === "string" ? [v] : Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
    const names = ids.map((id) => index.lookup(rule.assetType, id)).filter((n): n is string => Boolean(n));
    if (names.length !== ids.length || !names.length) continue;
    refs[rule.ref] = rule.many ? names : names[0]!;
  }
  const files: DesiredFile[] = snap.files.filter((f) => f.content !== undefined).map((f) => ({ path: f.path, encoding: f.encoding, content: f.content! }));
  const asset = { assetType: snap.assetType, assetId: snap.assetId, metadata: { ...snap.metadata }, files, ...(Object.keys(refs).length ? { refs } : {}) };
  return { ...asset, key: assetIdentity(policy, asset, index.lookup) };
}

export interface DraftValidationContext {
  policy: Pick<Policy, "assetTypes" | "agentTypes" | "limits" | "plans">;
  live: Awaited<ReturnType<typeof loadLiveIndex>>;
  base: { metadata: Record<string, unknown>; contentHash: string } | null;
  rules: EditRules;
}

/** Validation on save: the asset on its own, the edit rules, and the set rules against the live index. Pure. */
export function validateDraft(desired: DesiredAsset, ctx: DraftValidationContext): ValidationResult[] {
  const key = `${desired.assetType}:${desired.key}`;
  const own = validateDraftAsset(desired, { policy: ctx.policy, previous: ctx.base ? { metadata: ctx.base.metadata } : undefined });
  const edit = editViolations(ctx.rules, ctx.base, { metadata: desired.metadata, contentHash: desiredContentHash(desired.files) }, key);
  const set = validateAssetSet([desired], { policy: ctx.policy, live: ctx.live, perAsset: false });
  return [...own, ...edit, ...set];
}

function rulesFor(policy: DraftValidationContext["policy"], desired: Pick<DesiredAsset, "assetType" | "metadata" | "refs">, nameOf: (t: string, id: string) => string | undefined): EditRules {
  return editRulesFor(policy, desired.assetType, isManagedAsset(policy, desired, nameOf));
}

async function insertDraft(space: Space, actor: DraftActor, values: Omit<typeof drafts.$inferInsert, "spaceId" | "createdBy" | "updatedBy">): Promise<{ draftId: string; existing: boolean }> {
  if (values.assetId) {
    const [open] = await db()
      .select({ id: drafts.id })
      .from(drafts)
      .where(and(eq(drafts.spaceId, space.id), eq(drafts.assetId, values.assetId), eq(drafts.createdBy, actor.email), inArray(drafts.status, ["open", "planned"])));
    if (open) return { draftId: open.id, existing: true };
  }
  const [row] = await db()
    .insert(drafts)
    .values({ ...values, spaceId: space.id, createdBy: actor.email, updatedBy: actor.email })
    .returning({ id: drafts.id });
  await recordAuditEvent({
    actor: { email: actor.email, name: actor.name ?? null },
    action: "draft.create",
    spaceId: space.id,
    targetType: "draft",
    targetId: row!.id,
    details: { assetType: values.assetType, assetId: values.assetId ?? null, origin: values.origin, baseVersion: values.baseVersion ?? null },
  });
  return { draftId: row!.id, existing: false };
}

export interface CreateDraftDeps {
  /** Live reads (defaults to the space's read role) */
  reader?: LiveReader;
}

/**
 * "Edit as draft": a draft of an existing asset from its live state (the
 * default) or from its last commit in the history repository. Returns the
 * user's open draft of the asset when there is one. When the live read
 * fails (no credentials, the space unreachable), the draft starts from the
 * last synced version instead, the way the draft editor loader falls back:
 * its base is that version, so the plan check still catches a live change.
 */
export async function createDraftFromAsset(
  input: { spaceId: string; assetId: string; from?: "live" | "committed" },
  actor: DraftActor,
  deps: CreateDraftDeps = {},
): Promise<{ draftId: string; existing: boolean }> {
  const space = await spaceOrThrow(input.spaceId);
  const policy = await policyForSpace(space);
  const { live, nameOf } = await liveContext(space.id);
  const index = new IdentityIndex(policy, live);

  let start: DraftStart | null = null;
  let liveError: unknown = null;
  if ((input.from ?? "live") === "live") {
    try {
      const reader = deps.reader ?? spaceReader(devOpsAgentClient(toAwsConfig(space), "read", actor), space, policy);
      const asset = await reader.getAsset(input.assetId);
      if (!asset) throw new PlanServiceError("The asset no longer exists in the space.", {}, 404);
      start = { origin: "live", snap: await reader.snapshot(asset, asset), base: { version: asset.version, updatedAt: asset.updatedAt, commit: null } };
    } catch (err) {
      if (err instanceof PlanServiceError) throw err;
      liveError = err;
    }
  }
  start ??= await committedStart(space, policy, input.assetId, liveError);
  const { origin, snap, base } = start;

  const desired = desiredFromSnapshot(policy, snap, index);
  const rules = rulesFor(policy, desired, nameOf);
  if (!rules.editable) throw new PlanServiceError(rules.reason ?? "This asset can't be edited in this app.", {}, 409);
  const baseState = { metadata: snap.metadata, contentHash: snapshotContentHash({ files: snap.files }) };
  return insertDraft(space, actor, {
    assetType: snap.assetType,
    assetId: snap.assetId,
    assetKey: desired.key,
    name: assetDisplayName(policy.historyLayout, snap),
    origin,
    baseVersion: base.version,
    baseUpdatedAt: base.updatedAt,
    baseCommit: base.commit,
    baseMetadata: snap.metadata,
    baseContentHash: baseState.contentHash,
    desired,
    validation: validateDraft(desired, { policy, live, base: baseState, rules }),
  });
}

interface DraftStart {
  origin: "live" | "committed";
  snap: Pick<AssetSnapshot, "assetId" | "assetType" | "metadata" | "files">;
  base: { version: number; updatedAt: Date; commit: string | null };
}

/** The asset's last committed (synced) version as a draft's starting point. `liveError`: why live was not used. */
async function committedStart(space: Space, policy: Policy, assetId: string, liveError: unknown): Promise<DraftStart> {
  // With a live error the message says both what failed and why the fallback can't help.
  const unreadable = (rest: string) => `The live space could not be read, and ${rest} ${plainErrorOf(liveError)}`;
  const [row] = await db().select().from(assetIndex).where(and(eq(assetIndex.spaceId, space.id), eq(assetIndex.assetId, assetId)));
  if (!row?.gitPath || row.deletedAt) {
    if (liveError) throw new PlanServiceError(unreadable("the history repository has no synced version of this asset to start from."), {}, 409);
    throw new PlanServiceError("The asset has no committed version in the history repository.", {}, 404);
  }
  const repo = await openSpaceHistoryRepo(space, policy.historyLayout);
  if (!repo.ok) throw new PlanServiceError(liveError ? unreadable(`the history repository can't be opened: ${repo.message}`) : repo.message, {}, 409);
  const committed = await readCommittedAsset(repo.repo, row.gitPath, policy.historyLayout, "HEAD", { maxFileBytes: policy.historyLayout.maxCommittedFileBytes });
  if (!committed) throw new PlanServiceError(liveError ? unreadable("the synced version could not be read.") : "The committed version could not be read.", {}, 409);
  if (committed.files.some((f) => f.content === null)) {
    throw new PlanServiceError(
      liveError
        ? unreadable("some files of this asset are not in the history repository (too large or binary).")
        : "Some files of this asset are not in git (too large or binary). Start the draft from the live space instead.",
      {},
      409,
    );
  }
  const j = committed.assetJson;
  return {
    origin: "committed",
    snap: {
      assetId: j.assetId,
      assetType: j.assetType,
      metadata: j.metadata,
      files: committed.files.map((f) => ({ path: f.path, sha256: f.sha256 ?? "", size: f.size ?? 0, encoding: "utf8" as const, content: f.content! })),
    },
    base: { version: j.serviceVersion, updatedAt: new Date(j.serviceUpdatedAt), commit: committed.commit },
  };
}

const fileInput = z.object({ path: z.string().min(1).max(512), encoding: z.enum(["utf8", "base64"]).default("utf8"), content: z.string() });
const draftContentInput = z.object({
  metadata: z.record(z.string(), z.unknown()).optional(),
  files: z.array(fileInput).max(2000).optional(),
  refs: z.record(z.string(), z.union([z.string(), z.array(z.string())])).optional(),
  /** "merge": `files` holds only changed files; the rest stay as they are. Default "replace". */
  filesMode: z.enum(["replace", "merge"]).optional(),
});

/** The draft's files with `changed` replacing (or adding) files by path. Pure. */
export function mergeFiles(prev: readonly DesiredFile[], changed: readonly DesiredFile[]): DesiredFile[] {
  const byPath = new Map(changed.map((f) => [f.path, f]));
  const kept = prev.map((f) => byPath.get(f.path) ?? f);
  const added = changed.filter((f) => !prev.some((p) => p.path === f.path));
  return [...kept, ...added];
}

/** "New <type>": a draft of a new asset. Files default to an empty main file. */
export async function createNewDraft(input: { spaceId: string; assetType: string } & z.input<typeof draftContentInput>, actor: DraftActor): Promise<{ draftId: string }> {
  const space = await spaceOrThrow(input.spaceId);
  const policy = await policyForSpace(space);
  const entry = policy.assetTypes.assetTypes[input.assetType];
  if (!entry) throw new PlanServiceError(`Unknown asset type ${input.assetType}.`);
  if (!entry.editable) throw new PlanServiceError(`${entry.label} assets can't be created in this app.`);
  const content = draftContentInput.parse(input);
  const { live, nameOf } = await liveContext(space.id);
  const index = new IdentityIndex(policy, live);
  const files: DesiredFile[] = content.files ?? (entry.mainFile ? [{ path: entry.mainFile, encoding: "utf8", content: "" }] : []);
  const asset = { assetType: input.assetType, metadata: content.metadata ?? {}, files, ...(content.refs ? { refs: content.refs } : {}) };
  const desired: DesiredAsset = { ...asset, key: assetIdentity(policy, asset, index.lookup) };
  const rules = rulesFor(policy, desired, nameOf);
  const r = await insertDraft(space, actor, {
    assetType: input.assetType,
    assetId: null,
    assetKey: desired.key,
    name: assetDisplayName(policy.historyLayout, { assetId: "", assetType: input.assetType, metadata: desired.metadata }) || desired.key,
    origin: "new",
    desired,
    validation: validateDraft(desired, { policy, live, base: null, rules }),
  });
  return { draftId: r.draftId };
}

/**
 * Save a draft. Replaces the given parts (metadata, files, refs), recomputes
 * the identity key and validates. `expectedUpdatedAt` guards against a save
 * over a newer one. Saving a draft that is in an open plan re-checks the plan.
 */
export async function updateDraft(
  input: { spaceId: string; draftId: string; expectedUpdatedAt?: string | null } & z.input<typeof draftContentInput>,
  actor: DraftActor,
): Promise<{ draft: DraftRow; validation: ValidationResult[]; recheckRunId: string | null }> {
  const draft = await draftOrThrow(input.spaceId, input.draftId);
  if (!sameUser(draft.createdBy, actor.email)) throw new PlanServiceError("Only the author of a draft can change it.", {}, 403);
  if (draft.status !== "open" && draft.status !== "planned") throw new PlanServiceError(`This draft is ${draft.status} and can't be changed.`, {}, 409);
  if (input.expectedUpdatedAt && new Date(input.expectedUpdatedAt).getTime() !== draft.updatedAt.getTime()) {
    throw new PlanServiceError("This draft was saved somewhere else since you opened it. Reload it to see the latest version.", {}, 409);
  }
  const plan = draft.planId ? await dbPlanStore.getPlan(draft.planId) : null;
  if (plan && !OPEN_STATES.includes(plan.state)) throw new PlanServiceError(`The plan with this draft is ${plan.state}; the draft can't change now.`, {}, 409);

  const space = await spaceOrThrow(input.spaceId);
  const policy = await policyForSpace(space);
  const content = draftContentInput.parse(input);
  const { live, nameOf } = await liveContext(space.id);
  const index = new IdentityIndex(policy, live);
  const prev = draft.desired;
  const asset = {
    assetType: prev.assetType,
    ...(prev.assetId ? { assetId: prev.assetId } : {}),
    metadata: content.metadata ?? prev.metadata,
    files: content.files ? (content.filesMode === "merge" ? mergeFiles(prev.files, content.files) : content.files) : prev.files,
    ...((content.refs ?? prev.refs) ? { refs: content.refs ?? prev.refs } : {}),
  };
  const desired: DesiredAsset = { ...asset, key: assetIdentity(policy, asset, index.lookup) };
  const base = draft.baseMetadata ? { metadata: draft.baseMetadata, contentHash: draft.baseContentHash ?? "" } : null;
  // Edit rules come from the base (a managed memory stays managed even if its store reference is edited).
  const rules = rulesFor(policy, base ? { assetType: prev.assetType, metadata: base.metadata, refs: prev.refs } : desired, nameOf);
  const validation = validateDraft(desired, { policy, live, base, rules });

  const [row] = await db()
    .update(drafts)
    .set({
      desired,
      assetKey: desired.key,
      name: assetDisplayName(policy.historyLayout, { assetId: prev.assetId ?? "", assetType: prev.assetType, metadata: desired.metadata }) || desired.key,
      validation,
      updatedBy: actor.email,
      updatedAt: new Date(),
    })
    .where(and(eq(drafts.id, draft.id), sql`date_trunc('milliseconds', ${drafts.updatedAt}) = ${draft.updatedAt.toISOString()}::timestamptz`))
    .returning();
  if (!row) throw new PlanServiceError("This draft was saved somewhere else at the same time. Reload it.", {}, 409);

  let recheckRunId: string | null = null;
  if (plan) recheckRunId = await requestCheck(plan, await dbPlanStore.getItems(plan.id), actor, { rebase: false });
  const changed = changedParts(prev, desired);
  await recordAuditEvent({
    actor: { email: actor.email, name: actor.name ?? null },
    action: "draft.save",
    spaceId: draft.spaceId,
    targetType: "draft",
    targetId: draft.id,
    details: { assetId: draft.assetId, assetType: draft.assetType, baseVersion: draft.baseVersion, files: changed.files, metadataKeys: changed.metadataKeys, recheckRunId },
  });
  return { draft: row, validation, recheckRunId };
}

/** Paths of files added, removed or changed, and metadata keys changed, between two versions of a draft. Pure. */
export function changedParts(before: Pick<DesiredAsset, "metadata" | "files">, after: Pick<DesiredAsset, "metadata" | "files">): { files: string[]; metadataKeys: string[] } {
  const paths = [...new Set([...before.files.map((f) => f.path), ...after.files.map((f) => f.path)])].sort();
  const files = paths.filter((p) => {
    const a = before.files.find((f) => f.path === p);
    const b = after.files.find((f) => f.path === p);
    return !a || !b || a.content !== b.content || a.encoding !== b.encoding;
  });
  const keys = [...new Set([...Object.keys(before.metadata), ...Object.keys(after.metadata)])].sort();
  return { files, metadataKeys: keys.filter((k) => !sameValue(before.metadata[k], after.metadata[k])) };
}

/**
 * The first "Save draft" of an asset: start the draft from the version the
 * editor showed (live, or the last commit when live could not be read), then
 * save the user's edits on it. Refused when live moved since the editor was
 * opened, so edits are never saved on a base the user didn't see.
 */
export async function saveNewDraft(
  input: { spaceId: string; assetId: string; from: "live" | "committed"; expectedBaseVersion: number } & z.input<typeof draftContentInput>,
  actor: DraftActor,
  deps: CreateDraftDeps = {},
): Promise<{ draftId: string; updatedAt: Date; validation: ValidationResult[] }> {
  const created = await createDraftFromAsset({ spaceId: input.spaceId, assetId: input.assetId, from: input.from }, actor, deps);
  const draft = await draftOrThrow(input.spaceId, created.draftId);
  if (created.existing) {
    throw new PlanServiceError("You already have a draft of this asset. Reload the page to open it; your text is still in the editor.", {}, 409);
  }
  if (draft.baseVersion !== input.expectedBaseVersion) {
    throw new PlanServiceError(
      `Live moved to v${draft.baseVersion} since you opened the editor. Your text is still in the editor: copy it, reload the page, and make your edits on v${draft.baseVersion}.`,
      {},
      409,
    );
  }
  const saved = await updateDraft(
    { spaceId: input.spaceId, draftId: draft.id, expectedUpdatedAt: draft.updatedAt.toISOString(), metadata: input.metadata, files: input.files, refs: input.refs, filesMode: input.filesMode },
    actor,
  );
  return { draftId: draft.id, updatedAt: saved.draft.updatedAt, validation: saved.validation };
}

/**
 * "Use v<b> as the base": move the draft's base to the asset's live version,
 * keeping the draft's files and metadata. The diff then shows what the
 * draft's text replaces in the newer version.
 */
export async function rebaseDraft(input: { spaceId: string; draftId: string }, actor: DraftActor, deps: CreateDraftDeps = {}): Promise<{ baseVersion: number; validation: ValidationResult[] }> {
  const draft = await draftOrThrow(input.spaceId, input.draftId);
  if (!sameUser(draft.createdBy, actor.email)) throw new PlanServiceError("Only the author of a draft can change it.", {}, 403);
  if (draft.status !== "open") throw new PlanServiceError(draft.status === "planned" ? "This draft is in a plan. Discard the plan to edit the draft again." : `This draft is ${draft.status}.`, {}, 409);
  if (!draft.assetId) throw new PlanServiceError("A draft of a new asset has no live version to use as its base.", {}, 409);
  const space = await spaceOrThrow(input.spaceId);
  const policy = await policyForSpace(space);
  const reader = deps.reader ?? spaceReader(devOpsAgentClient(toAwsConfig(space), "read", actor), space, policy);
  let asset: Awaited<ReturnType<LiveReader["getAsset"]>>;
  let snap: AssetSnapshot;
  try {
    asset = await reader.getAsset(draft.assetId);
    if (!asset) throw new PlanServiceError("The asset no longer exists in the space.", {}, 404);
    snap = await reader.snapshot(asset, asset);
  } catch (err) {
    if (err instanceof PlanServiceError) throw err;
    throw new PlanServiceError(`The live space could not be read, so the draft keeps its base. ${plainErrorOf(err)}`, {}, 409);
  }
  const { live, nameOf } = await liveContext(space.id);
  const base = { metadata: snap.metadata, contentHash: snapshotContentHash({ files: snap.files }) };
  const rules = rulesFor(policy, { assetType: draft.assetType, metadata: base.metadata, refs: draft.desired.refs }, nameOf);
  const validation = validateDraft(draft.desired, { policy, live, base, rules });
  const [row] = await db()
    .update(drafts)
    .set({
      baseVersion: asset.version,
      baseUpdatedAt: asset.updatedAt,
      baseCommit: null,
      baseMetadata: snap.metadata,
      baseContentHash: base.contentHash,
      origin: "live",
      validation,
      updatedBy: actor.email,
      updatedAt: new Date(),
    })
    .where(and(eq(drafts.id, draft.id), eq(drafts.status, "open")))
    .returning({ id: drafts.id });
  if (!row) throw new PlanServiceError("The draft changed in the meantime. Reload the page.", {}, 409);
  await recordAuditEvent({
    actor: { email: actor.email, name: actor.name ?? null },
    action: "draft.rebase",
    spaceId: draft.spaceId,
    targetType: "draft",
    targetId: draft.id,
    details: { assetId: draft.assetId, fromVersion: draft.baseVersion, toVersion: asset.version },
  });
  return { baseVersion: asset.version, validation };
}

/** Discard an open draft. A draft in a plan stays until the plan is discarded or applied. */
export async function discardDraft(input: { spaceId: string; draftId: string }, actor: DraftActor): Promise<void> {
  const draft = await draftOrThrow(input.spaceId, input.draftId);
  if (!sameUser(draft.createdBy, actor.email) && !hasPermission(actor, ADMIN)) throw new PlanServiceError("Only the author of a draft or an Admin can discard it.", {}, 403);
  if (draft.status === "planned") throw new PlanServiceError("This draft is in a plan. Discard the plan first; the draft stays saved.", {}, 409);
  if (draft.status !== "open") throw new PlanServiceError(`This draft is already ${draft.status}.`, {}, 409);
  const [row] = await db()
    .update(drafts)
    .set({ status: "discarded", discardedBy: actor.email, discardedAt: new Date(), updatedAt: new Date() })
    .where(and(eq(drafts.id, draft.id), eq(drafts.status, "open")))
    .returning({ id: drafts.id });
  if (!row) throw new PlanServiceError("The draft changed in the meantime. Reload the page.", {}, 409);
  await recordAuditEvent({
    actor: { email: actor.email, name: actor.name ?? null },
    action: "draft.discard",
    spaceId: draft.spaceId,
    targetType: "draft",
    targetId: draft.id,
    details: { assetType: draft.assetType, assetId: draft.assetId, name: draft.name },
  });
}

/**
 * "Create plan" on the drafts screen: one plan from the user's open drafts in
 * the space. The drafts become "planned" in the same transaction.
 */
export async function createPlanFromDrafts(
  input: { spaceId: string; draftIds: string[]; title?: string | null; reason?: string | null },
  actor: DraftActor,
): Promise<{ planId: string; checkRunId: string }> {
  if (!hasPermission(actor, "plans.create")) throw new PlanServiceError("You need the Editor role to create a plan.", {}, 403);
  const ids = [...new Set(input.draftIds)].filter((id) => UUID_RE.test(id));
  if (!ids.length) throw new PlanServiceError("Choose at least one draft.");
  const rows = await db().select().from(drafts).where(and(eq(drafts.spaceId, input.spaceId), inArray(drafts.id, ids)));
  if (rows.length !== ids.length) throw new PlanServiceError("Some drafts were not found in this space.", {}, 404);
  for (const d of rows) {
    if (!sameUser(d.createdBy, actor.email)) throw new PlanServiceError(`${d.name} is another user's draft.`, {}, 403);
    if (d.status !== "open") throw new PlanServiceError(`${d.name} is ${d.status === "planned" ? "already in a plan" : d.status}.`, {}, 409);
  }
  const ordered = ids.map((id) => rows.find((r) => r.id === id)!);
  const title = input.title?.trim() || (ordered.length === 1 ? `Update ${ordered[0]!.name}` : `Update ${ordered.length} assets`);
  return createPlanInternal(
    {
      spaceId: input.spaceId,
      title,
      origin: { kind: "drafts", draftIds: ids },
      reason: input.reason ?? null,
      items: ordered.map((d) => ({ desired: d.desired, baseVersion: d.baseVersion, baseUpdatedAt: d.baseUpdatedAt?.toISOString() ?? null, draftId: d.id })),
    },
    actor,
    {
      inTx: async (tx, planId) => {
        const updated = await tx
          .update(drafts)
          .set({ status: "planned", planId, updatedAt: new Date() })
          .where(and(inArray(drafts.id, ids), eq(drafts.status, "open")))
          .returning({ id: drafts.id });
        if (updated.length !== ids.length) throw new PlanServiceError("A draft changed while the plan was created. Try again.", {}, 409);
      },
    },
  );
}

/** Drafts of a space, newest first; `createdBy` for one user's drafts. Open and planned by default. */
export async function listDrafts(spaceId: string, opts: { createdBy?: string; statuses?: DraftRow["status"][] } = {}): Promise<DraftRow[]> {
  const where: SQL[] = [eq(drafts.spaceId, spaceId), inArray(drafts.status, opts.statuses ?? ["open", "planned"])];
  if (opts.createdBy) where.push(eq(drafts.createdBy, opts.createdBy));
  return db()
    .select()
    .from(drafts)
    .where(and(...where))
    .orderBy(desc(drafts.updatedAt));
}

export async function getDraft(spaceId: string, draftId: string): Promise<DraftRow | null> {
  if (!UUID_RE.test(draftId)) return null;
  const [row] = await db().select().from(drafts).where(and(eq(drafts.id, draftId), eq(drafts.spaceId, spaceId)));
  return row ?? null;
}

/** The draft's space, for the Server Action's permission check. */
export async function draftAccessContext(draftId: string): Promise<{ spaceId: string; createdBy: string; status: DraftRow["status"] } | null> {
  if (!UUID_RE.test(draftId)) return null;
  const [row] = await db().select({ spaceId: drafts.spaceId, createdBy: drafts.createdBy, status: drafts.status }).from(drafts).where(eq(drafts.id, draftId));
  return row ?? null;
}
