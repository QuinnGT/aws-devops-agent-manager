import { and, count, eq, inArray, sql } from "drizzle-orm";
import { diffAssetVersions, type FileDiff, type ValueChange } from "@/server/assets/diff";
import { openSpaceHistoryRepo, readCommittedAsset } from "@/server/assets/repo";
import type { SizeMeter } from "@/server/assets/size-meter";
import { devOpsAgentClient } from "@/server/aws/clients";
import { db } from "@/server/db/client";
import { assetIndex, drafts as draftsTable, plans, user } from "@/server/db/schema";
import { env } from "@/server/env";
import { plainErrorOf } from "@/server/jobs/error-text";
import { assetLabel } from "@/server/history/display-name";
import type { DesiredAsset } from "@/server/packages/types";
import type { LiveReader } from "@/server/plans/check";
import { desiredVersionContent, liveVersionContent, snapshotContentHash } from "@/server/plans/content";
import { liveMovedPast, sizeMeterFor, validationStatusOf } from "@/server/plans/decide";
import { IdentityIndex } from "@/server/plans/resolve";
import { loadLiveIndex, policyForSpace, recordedSource, spaceReader } from "@/server/plans/runtime";
import { OPEN_STATES, type Badge, PLAN_STATE_BADGES } from "@/server/plans/states";
import { dbPlanStore } from "@/server/plans/store";
import type { DraftRow, PlanActor, PlanState } from "@/server/plans/types";
import { getAppPolicy, type Policy } from "@/server/policy";
import { getSpaceById, type Space, toAwsConfig } from "@/server/spaces/queries";
import { mainFileOf } from "@/server/validation/asset";
import { resolvedSchema, type JsonSchema } from "@/server/validation/schemas";
import { errorsOf, warningsOf, type ValidationResult } from "@/server/validation/types";
import { editRulesFor, type EditRules, isManagedAsset } from "./rules";
import { desiredFromSnapshot, getDraft, listDrafts, validateDraft } from "./service";
import { alsoHasDraftNote, type DraftChange, draftChange, orderDrafts } from "./view";

/**
 * Page loaders: the drafts list and the draft editor (content,
 * validation, size meter and the diff against live). The page checks access
 * with the DAL first and passes the viewer.
 */

export interface DraftListRow {
  id: string;
  name: string;
  assetType: string;
  typeLabel: string;
  assetId: string | null;
  origin: DraftRow["origin"];
  status: DraftRow["status"];
  planId: string | null;
  validation: { status: "passed" | "warnings" | "failed"; errors: number; warnings: number };
  baseVersion: number | null;
  createdBy: string;
  updatedAt: Date;
}

function listRow(d: DraftRow): DraftListRow {
  const v = (d.validation ?? []) as ValidationResult[];
  return {
    id: d.id,
    name: d.name,
    assetType: d.assetType,
    typeLabel: getAppPolicy().policy.assetTypes.assetTypes[d.assetType]?.label ?? d.assetType,
    assetId: d.assetId,
    origin: d.origin,
    status: d.status,
    planId: d.planId,
    validation: { status: validationStatusOf(v), errors: errorsOf(v).length, warnings: warningsOf(v).length },
    baseVersion: d.baseVersion,
    createdBy: d.createdBy,
    updatedAt: d.updatedAt,
  };
}

/** Open and planned drafts of a space; `mine` limits them to the viewer's. */
export async function loadDraftList(spaceId: string, viewer: Pick<PlanActor, "email">, opts: { mine?: boolean } = {}): Promise<DraftListRow[]> {
  const rows = await listDrafts(spaceId, opts.mine ? { createdBy: viewer.email } : {});
  return rows.map(listRow);
}

export interface ReferenceField {
  key: string;
  ref: string;
  assetType: string;
  many: boolean;
  required: boolean;
  /** Live assets of the referenced type, by name */
  options: { assetId: string; name: string }[];
}

export type LiveComparison =
  | { ok: true; exists: true; version: number; updatedAt: Date; movedPastBase: boolean }
  | { ok: true; exists: false }
  | { ok: false; error: string };

export interface DraftEditor {
  draft: {
    id: string;
    name: string;
    assetType: string;
    assetId: string | null;
    origin: DraftRow["origin"];
    status: DraftRow["status"];
    baseVersion: number | null;
    baseUpdatedAt: Date | null;
    baseCommit: string | null;
    createdBy: string;
    /** Pass back as expectedUpdatedAt when saving */
    updatedAt: string;
  };
  desired: DesiredAsset;
  type: {
    label: string;
    content: "single-file" | "multi-file" | "binary";
    mainFile: string | null;
    supportsStatus: boolean;
    /** Metadata JSON Schema with policy $defs filled in, for the generated form */
    metadataSchema: JsonSchema | null;
    references: ReferenceField[];
  };
  rules: EditRules;
  canEdit: boolean;
  /** Why the draft can't be edited */
  lockedReason: string | null;
  validation: ValidationResult[];
  sizeMeter: SizeMeter | null;
  live: LiveComparison;
  /**
   * The version the editor compares the draft with: live, or the last
   * committed version when live can't be read. Files carry their text so the
   * editor can diff unsaved edits in the browser.
   */
  against: AgainstVersion | null;
  /** Live against the draft */
  diff: { metadata: ValueChange[]; files: FileDiff[]; added: number; removed: number } | null;
  plan: { id: string; title: string; state: PlanState; badge: Badge } | null;
}

export interface DraftEditorDeps {
  /** Live reads (defaults to the space's read role) */
  reader?: LiveReader;
}

/** Everything the draft editor shows. Null when the draft is not in this space. */
export async function loadDraftEditor(spaceId: string, draftId: string, viewer: Pick<PlanActor, "email">, deps: DraftEditorDeps = {}): Promise<DraftEditor | null> {
  const draft = await getDraft(spaceId, draftId);
  if (!draft) return null;
  const space = await getSpaceById(spaceId);
  if (!space) return null;
  const policy = await policyForSpace(space);
  const live = await loadLiveIndex(space.id);
  const nameOf = (t: string, id: string) => live.find((a) => a.assetId === id && a.assetType === t)?.name;
  const desired = draft.desired;
  const entry = policy.assetTypes.assetTypes[draft.assetType];
  const base = draft.baseMetadata ? { metadata: draft.baseMetadata, contentHash: draft.baseContentHash ?? "" } : null;
  const rules = editRulesFor(policy, draft.assetType, isManagedAsset(policy, base ? { assetType: draft.assetType, metadata: base.metadata, refs: desired.refs } : desired, nameOf));
  const validation = validateDraft(desired, { policy, live, base, rules });
  const plan = draft.planId ? await dbPlanStore.getPlan(draft.planId) : null;

  let comparison: LiveComparison = { ok: true, exists: false };
  let diff: DraftEditor["diff"] = null;
  let against: AgainstVersion | null = null;
  const toDiff = (metadata: Record<string, unknown>, files: Parameters<typeof liveVersionContent>[1]) => {
    const d = diffAssetVersions(liveVersionContent(metadata, files), desiredVersionContent(desired.metadata, desired.files));
    const changed = d.files.filter((f) => f.status !== "unchanged");
    return { metadata: d.metadata, files: changed, added: changed.reduce((n, f) => n + f.added, 0), removed: changed.reduce((n, f) => n + f.removed, 0) };
  };
  if (draft.assetId) {
    const read = await readAgainst(space, policy, draft.assetId, viewer, deps);
    comparison = read.comparison;
    if (read.against) {
      against = read.against;
      if (comparison.ok && comparison.exists) comparison = { ...comparison, movedPastBase: liveMovedPast({ version: draft.baseVersion, updatedAt: draft.baseUpdatedAt }, comparison) };
      diff = toDiff(read.against.metadata, read.against.files.map((f) => ({ path: f.path, sha256: f.sha256, size: f.size, encoding: f.encoding, content: f.content ?? undefined })));
    }
  } else {
    diff = toDiff({}, []);
  }

  const author = draft.createdBy.trim().toLowerCase() === viewer.email.trim().toLowerCase();
  const planOpen = !plan || OPEN_STATES.includes(plan.state);
  const lockedReason = !author
    ? "Only the author of a draft can change it."
    : draft.status !== "open" && draft.status !== "planned"
      ? `This draft is ${draft.status}.`
      : !planOpen
        ? `The plan with this draft is ${plan!.state}.`
        : !rules.editable
          ? rules.reason
          : null;

  return {
    draft: {
      id: draft.id,
      name: draft.name,
      assetType: draft.assetType,
      assetId: draft.assetId,
      origin: draft.origin,
      status: draft.status,
      baseVersion: draft.baseVersion,
      baseUpdatedAt: draft.baseUpdatedAt,
      baseCommit: draft.baseCommit,
      createdBy: draft.createdBy,
      updatedAt: draft.updatedAt.toISOString(),
    },
    desired,
    type: {
      label: entry?.label ?? draft.assetType,
      content: entry?.content ?? "single-file",
      mainFile: entry ? (mainFileOf(entry, desired.files)?.path ?? entry.mainFile ?? null) : null,
      supportsStatus: entry?.supportsStatus ?? false,
      metadataSchema: entry ? (resolvedSchema(policy, draft.assetType) ?? null) : null,
      references: (entry?.references ?? []).map((r) => ({
        key: r.key,
        ref: r.ref,
        assetType: r.assetType,
        many: r.many,
        required: r.required,
        options: live.filter((a) => a.assetType === r.assetType).map((a) => ({ assetId: a.assetId, name: a.name })),
      })),
    },
    rules,
    canEdit: lockedReason === null,
    lockedReason,
    validation,
    sizeMeter: sizeMeterFor(policy, desired),
    live: comparison,
    against,
    diff,
    plan: plan ? { id: plan.id, title: plan.title, state: plan.state, badge: PLAN_STATE_BADGES[plan.state] } : null,
  };
}

// ---------------------------------------------------------------------------
// The version a draft is compared with, and the pages built on these loaders.
// ---------------------------------------------------------------------------

export interface AgainstVersion {
  /** "live": read from the space now; "committed": the last version in the history repository (live could not be read) */
  source: "live" | "committed";
  version: number;
  updatedAt: Date;
  metadata: Record<string, unknown>;
  files: { path: string; sha256: string; size: number; encoding: "utf8" | "base64"; content: string | null }[];
  /** Why live could not be read (source "committed") */
  liveError: string | null;
}


/** The asset's last committed version in the history repository, or null. */
export async function committedVersion(space: Space, policy: Policy, assetId: string): Promise<Omit<AgainstVersion, "source" | "liveError"> | null> {
  const [row] = await db().select({ gitPath: assetIndex.gitPath }).from(assetIndex).where(and(eq(assetIndex.spaceId, space.id), eq(assetIndex.assetId, assetId)));
  if (!row?.gitPath) return null;
  const repo = await openSpaceHistoryRepo(space, policy.historyLayout);
  if (!repo.ok) return null;
  const c = await readCommittedAsset(repo.repo, row.gitPath, policy.historyLayout, "HEAD", { maxFileBytes: policy.historyLayout.maxCommittedFileBytes });
  if (!c) return null;
  return {
    version: c.assetJson.serviceVersion,
    updatedAt: new Date(c.assetJson.serviceUpdatedAt),
    metadata: c.assetJson.metadata,
    files: c.files.map((f) => ({ path: f.path, sha256: f.sha256 ?? "", size: f.size ?? 0, encoding: "utf8" as const, content: f.content })),
  };
}

/**
 * Read the asset from the live space; when that fails (no credentials, the
 * space is unreachable), fall back to its last committed version so the
 * editor still shows a diff, labeled as such.
 */
async function readAgainst(
  space: Space,
  policy: Policy,
  assetId: string,
  viewer: Pick<PlanActor, "email">,
  deps: DraftEditorDeps,
): Promise<{ comparison: LiveComparison; against: AgainstVersion | null }> {
  try {
    const reader = deps.reader ?? spaceReader(devOpsAgentClient(toAwsConfig(space), "read", { email: viewer.email }), space, policy);
    const asset = await reader.getAsset(assetId);
    if (!asset) return { comparison: { ok: true, exists: false }, against: null };
    const snap = await reader.snapshot(asset, asset);
    return {
      comparison: { ok: true, exists: true, version: asset.version, updatedAt: asset.updatedAt, movedPastBase: false },
      against: {
        source: "live",
        version: asset.version,
        updatedAt: asset.updatedAt,
        metadata: snap.metadata,
        files: snap.files.map((f) => ({ path: f.path, sha256: f.sha256, size: f.size, encoding: f.encoding, content: f.content ?? null })),
        liveError: null,
      },
    };
  } catch (err) {
    const error = plainErrorOf(err);
    const committed = await committedVersion(space, policy, assetId).catch(() => null);
    return { comparison: { ok: false, error }, against: committed ? { ...committed, source: "committed", liveError: error } : null };
  }
}

/** Display names for emails: the sign-in users table, then the local bypass user; the email when neither knows it. */
export async function displayNames(emails: readonly string[]): Promise<(email: string) => string> {
  const unique = [...new Set(emails.map((e) => e.trim().toLowerCase()))].filter(Boolean);
  const rows = unique.length ? await db().select({ email: user.email, name: user.name }).from(user).where(inArray(sql`lower(${user.email})`, unique)) : [];
  const known = new Map(rows.map((r) => [r.email.toLowerCase(), r.name]));
  const dev = env().devBypass ? env().devUser : null;
  if (dev) known.set(dev.email.toLowerCase(), dev.name);
  return (email) => known.get(email.trim().toLowerCase()) || email;
}

export interface DraftTableRow {
  id: string;
  name: string;
  assetId: string | null;
  assetType: string;
  typeLabel: string;
  /** The memory store of a memory ("Memory in chat-tool-use-best-practices") */
  parentName: string | null;
  change: DraftChange;
  baseVersion: number | null;
  /** Live version from the live index */
  liveVersion: number | null;
  /** Live moved past the draft's base */
  liveMoved: boolean;
  /** The asset was deleted from the space after the draft was made */
  assetDeleted: boolean;
  validation: { status: "passed" | "warnings" | "failed"; errors: number; warnings: number; firstError: string | null };
  plan: { id: string; title: string; state: PlanState } | null;
  author: string;
  authorName: string;
  mine: boolean;
  /** " · you also have a draft" and similar, without the separator */
  alsoNote: string | null;
  updatedAt: Date;
}

export interface DraftTable {
  rows: DraftTableRow[];
  counts: { mine: number; all: number };
}

/** The drafts page table (pages/drafts.md): open and planned drafts in row order, filtered to the viewer's with `mine`. */
export async function loadDraftTable(spaceId: string, viewer: Pick<PlanActor, "email">, opts: { mine?: boolean } = {}): Promise<DraftTable> {
  const all = await listDrafts(spaceId);
  const assetIds = [...new Set(all.map((d) => d.assetId).filter((a): a is string => Boolean(a)))];
  const planIds = [...new Set(all.map((d) => d.planId).filter((p): p is string => Boolean(p)))];
  const [index, planRows, nameOf] = await Promise.all([
    assetIds.length
      ? db()
          .select({ assetId: assetIndex.assetId, liveVersion: assetIndex.liveVersion, deletedAt: assetIndex.deletedAt, parentAssetId: assetIndex.parentAssetId })
          .from(assetIndex)
          .where(and(eq(assetIndex.spaceId, spaceId), inArray(assetIndex.assetId, assetIds)))
      : Promise.resolve([]),
    planIds.length ? db().select({ id: plans.id, title: plans.title, state: plans.state }).from(plans).where(inArray(plans.id, planIds)) : Promise.resolve([]),
    displayNames(all.map((d) => d.createdBy)),
  ]);
  const parentIds = [...new Set(index.map((r) => r.parentAssetId).filter((p): p is string => Boolean(p)))];
  const parents = parentIds.length
    ? await db().select({ assetId: assetIndex.assetId, name: assetIndex.name }).from(assetIndex).where(and(eq(assetIndex.spaceId, spaceId), inArray(assetIndex.assetId, parentIds)))
    : [];
  const same = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();
  const ordered = orderDrafts(all, viewer.email);
  const rows = ordered.map((d): DraftTableRow => {
    const ix = d.assetId ? index.find((r) => r.assetId === d.assetId) : undefined;
    const v = (d.validation ?? []) as ValidationResult[];
    const errors = errorsOf(v);
    const plan = d.planId ? (planRows.find((p) => p.id === d.planId) ?? null) : null;
    const liveVersion = ix?.liveVersion ?? null;
    return {
      id: d.id,
      name: assetLabel(getAppPolicy().policy, { assetType: d.assetType, name: d.name, assetId: d.assetId, metadata: d.desired?.metadata }),
      assetId: d.assetId,
      assetType: d.assetType,
      typeLabel: getAppPolicy().policy.assetTypes.assetTypes[d.assetType]?.label ?? d.assetType,
      parentName: ix?.parentAssetId ? (parents.find((p) => p.assetId === ix.parentAssetId)?.name ?? null) : null,
      change: draftChange(d),
      baseVersion: d.baseVersion,
      liveVersion,
      liveMoved: d.baseVersion !== null && liveVersion !== null && liveVersion > d.baseVersion,
      assetDeleted: Boolean(d.assetId && (!ix || ix.deletedAt)),
      validation: { status: validationStatusOf(v), errors: errors.length, warnings: warningsOf(v).length, firstError: errors[0]?.message ?? null },
      plan,
      author: d.createdBy,
      authorName: nameOf(d.createdBy),
      mine: same(d.createdBy, viewer.email),
      alsoNote: alsoHasDraftNote(d, all, viewer.email, nameOf),
      updatedAt: d.updatedAt,
    };
  });
  const mine = rows.filter((r) => r.mine);
  return { rows: opts.mine ? mine : rows, counts: { mine: mine.length, all: rows.length } };
}

export interface OtherDraft {
  id: string;
  author: string;
  authorName: string;
  baseVersion: number | null;
  updatedAt: Date;
}

export interface AssetFacts {
  assetId: string;
  assetType: string;
  name: string;
  parentAssetId: string | null;
  parentName: string | null;
  liveVersion: number | null;
  liveUpdatedAt: Date | null;
  /** Deleted from the space (the live index marks it, or no longer lists it) */
  deleted: boolean;
  deletedAt: Date | null;
}

export interface DraftEditorPage {
  asset: AssetFacts;
  /** The draft shown: the viewer's own, another person's (`?draft=`), or null when the viewer has none yet */
  editor: DraftEditor | null;
  /** When the viewer has no draft yet: the editor model built from live (or the last commit) */
  fresh: FreshDraft | null;
  readOnly: boolean;
  authorName: string;
  /** Other people's open drafts of this asset */
  others: OtherDraft[];
  /** Source label of the live version when live moved past the draft's base ("DevOps Agent") */
  liveSource: string | null;
  policy: {
    agentTypes: { id: string; label: string }[];
    descriptionMaxChars: number;
    agentsMdMaxBytes: number;
    agentsMdRecommendedLines: number;
    identityKeys: string[];
    immutableKeys: string[];
    editable: boolean;
    noun: string;
  };
}

/** The starting point of a draft that doesn't exist yet. */
export interface FreshDraft {
  desired: DesiredAsset;
  against: AgainstVersion;
  rules: EditRules;
  metadataSchema: JsonSchema | null;
  references: ReferenceField[];
  label: string;
  content: "single-file" | "multi-file" | "binary";
  mainFile: string | null;
  supportsStatus: boolean;
  validation: ValidationResult[];
}

/** Keys named in an identity template such as "{memoryStore}/{name}". */
export function identityKeys(template: string | undefined): string[] {
  return [...(template ?? "").matchAll(/\{([^}]+)\}/g)].map((m) => m[1]!);
}

/**
 * Everything the draft editor page shows for an asset: the viewer's draft
 * (or another person's with `draftId`), or the live state to start one.
 * Null when the asset is not in the space's index.
 */
export async function loadDraftEditorPage(spaceId: string, assetId: string, viewer: Pick<PlanActor, "email">, opts: { draftId?: string | null } & DraftEditorDeps = {}): Promise<DraftEditorPage | null> {
  const space = await getSpaceById(spaceId);
  if (!space) return null;
  const [ix] = await db().select().from(assetIndex).where(and(eq(assetIndex.spaceId, spaceId), eq(assetIndex.assetId, assetId)));
  const drafts = (await listDrafts(spaceId)).filter((d) => d.assetId === assetId);
  if (!ix && !drafts.length) return null;
  const policy = await policyForSpace(space);
  const same = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();
  const nameOf = await displayNames(drafts.map((d) => d.createdBy));
  const requested = opts.draftId ? drafts.find((d) => d.id === opts.draftId) : undefined;
  const own = drafts.find((d) => same(d.createdBy, viewer.email));
  const shown = requested ?? own ?? null;
  const readOnly = Boolean(shown && !same(shown.createdBy, viewer.email));
  const entry = policy.assetTypes.assetTypes[ix?.assetType ?? shown?.assetType ?? ""];

  const parent = ix?.parentAssetId
    ? ((await db().select({ name: assetIndex.name }).from(assetIndex).where(and(eq(assetIndex.spaceId, spaceId), eq(assetIndex.assetId, ix.parentAssetId))))[0]?.name ?? null)
    : null;
  const asset: AssetFacts = {
    assetId,
    assetType: ix?.assetType ?? shown!.assetType,
    name: ix?.name ?? shown!.name,
    parentAssetId: ix?.parentAssetId ?? null,
    parentName: parent,
    liveVersion: ix?.liveVersion ?? null,
    liveUpdatedAt: ix?.liveUpdatedAt ?? null,
    deleted: !ix || Boolean(ix.deletedAt),
    deletedAt: ix?.deletedAt ?? null,
  };

  const editor = shown ? await loadDraftEditor(spaceId, shown.id, viewer, opts) : null;
  let fresh: FreshDraft | null = null;
  if (!shown && entry?.editable && ix && !ix.deletedAt) {
    const { comparison, against } = await readAgainst(space, policy, assetId, viewer, opts);
    if (against) {
      const live = await loadLiveIndex(space.id);
      const index = new IdentityIndex(policy, live);
      const desired = desiredFromSnapshot(policy, { assetId, assetType: ix.assetType, metadata: against.metadata, files: against.files.map((f) => ({ path: f.path, sha256: f.sha256, size: f.size, encoding: f.encoding, ...(f.content !== null ? { content: f.content } : {}) })) }, index);
      const lookupName = (t: string, id: string) => live.find((a) => a.assetId === id && a.assetType === t)?.name;
      const rules = editRulesFor(policy, ix.assetType, isManagedAsset(policy, desired, lookupName));
      const base = { metadata: against.metadata, contentHash: snapshotContentHash({ files: against.files.map((f) => ({ path: f.path, sha256: f.sha256, size: f.size, encoding: f.encoding, ...(f.content !== null ? { content: f.content } : {}) })) }) };
      fresh = {
        desired,
        against: comparison.ok ? against : { ...against, liveError: against.liveError },
        rules,
        metadataSchema: resolvedSchema(policy, ix.assetType) ?? null,
        references: (entry.references ?? []).map((r) => ({
          key: r.key,
          ref: r.ref,
          assetType: r.assetType,
          many: r.many,
          required: r.required,
          options: live.filter((a) => a.assetType === r.assetType).map((a) => ({ assetId: a.assetId, name: a.name })),
        })),
        label: entry.label,
        content: entry.content,
        mainFile: mainFileOf(entry, desired.files)?.path ?? entry.mainFile ?? null,
        supportsStatus: entry.supportsStatus,
        validation: validateDraft(desired, { policy, live, base, rules }),
      };
    }
  }

  const movedTo = editor?.live.ok && editor.live.exists && editor.live.movedPastBase ? editor.live.version : null;
  const liveSource = movedTo !== null ? await recordedSource(spaceId, assetId, movedTo) : null;
  return {
    asset,
    editor,
    fresh,
    readOnly,
    authorName: shown ? nameOf(shown.createdBy) : nameOf(viewer.email),
    others: drafts
      .filter((d) => !same(d.createdBy, viewer.email) && d.id !== shown?.id)
      .map((d) => ({ id: d.id, author: d.createdBy, authorName: nameOf(d.createdBy), baseVersion: d.baseVersion, updatedAt: d.updatedAt })),
    liveSource,
    policy: {
      agentTypes: policy.agentTypes.agentTypes.map((a) => ({ id: a.id, label: a.label })),
      descriptionMaxChars: policy.limits.descriptionMaxChars,
      agentsMdMaxBytes: policy.limits.agentsMdMaxBytes,
      agentsMdRecommendedLines: policy.limits.agentsMdRecommendedLines,
      identityKeys: identityKeys(entry?.identity).filter((k) => !(entry?.references ?? []).some((r) => r.ref === k)),
      immutableKeys: entry?.immutableKeys ?? [],
      editable: entry?.editable ?? false,
      noun: entry?.noun?.one ?? (entry?.label ?? asset.assetType).toLowerCase(),
    },
  };
}

/** Open and planned drafts of the space (the "Drafts" tab count). */
export async function countOpenDrafts(spaceId: string): Promise<number> {
  const [row] = await db()
    .select({ n: count() })
    .from(draftsTable)
    .where(and(eq(draftsTable.spaceId, spaceId), inArray(draftsTable.status, ["open", "planned"])));
  return row?.n ?? 0;
}
