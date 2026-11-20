import { eq } from "drizzle-orm";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { db } from "@/server/db/client";
import { agentSpaces, auditItems, audits, findings, reviews } from "@/server/db/schema";
import { getAppPolicy } from "@/server/policy";
import type { FindingRevisionLink, RevisionOption } from "@/server/revisions";
import type { Space } from "@/server/spaces/queries";
import { truncateAll } from "../../../test/helpers/db";
import { loadFindingDetail } from "./finding-detail";
import { loadFixContext } from "./fixes";
import { nextStepFor } from "./next-step";
import { profileOf } from "./store";

/**
 * The Findings tab's detail and where an audit's fixes go, against a
 * disposable database. The revisions contract (src/server/revisions/findings.ts)
 * is mocked: the audits side is written against its signatures.
 */

const r = vi.hoisted(() => ({
  links: new Map<string, unknown[]>() as Map<string, unknown[]>,
  options: [] as unknown[],
  list: [] as unknown[],
  sources: new Map<string, unknown[]>() as Map<string, unknown[]>,
  linksFail: false,
  optionsFail: false,
  listFail: false,
  asked: [] as { fn: string; ids?: string[] }[],
}));
vi.mock("@/server/revisions", () => ({
  findingRevisionLinks: vi.fn(async (_space: string, ids: string[]) => {
    r.asked.push({ fn: "links", ids });
    if (r.linksFail) throw new Error("revisions are down");
    return new Map(ids.map((id) => [id, r.links.get(id) ?? []]));
  }),
  listRevisionOptions: vi.fn(async () => {
    r.asked.push({ fn: "options" });
    if (r.optionsFail) throw new Error("revisions are down");
    return r.options;
  }),
  loadRevisionList: vi.fn(async () => {
    r.asked.push({ fn: "list" });
    if (r.listFail) throw new Error("revisions are down");
    return { revisions: r.list };
  }),
  revisionAuditSources: vi.fn(async (_space: string, ids: string[]) => new Map(ids.map((id) => [id, r.sources.get(id) ?? []]))),
}));

const policy = getAppPolicy();
const profile = { ...policy.policy.audits.profiles.benchmark!, review: { ...policy.policy.audits.profiles.benchmark!.review, modelId: "test-model" } };
const editor = { permissions: new Set(["audits.read", "findings.review", "revisions.build"] as const) };
const viewer = { permissions: new Set(["audits.read"] as const) };

let space: Space;
let other: Space;
let auditId: string;
let itemId: string;
const ids: Record<string, string> = {};
const LONG_FIX = `Extend the runbook memory runbooks/cache-evictions. ${"It should say which eviction metric shows lost keys and where to read it. ".repeat(8)}`.trim();

const link = (over: Partial<FindingRevisionLink> = {}): FindingRevisionLink => ({ revisionId: "rev-1", revisionName: "moss-lag-fixes", revisionState: "open", kind: "to-address", planId: null, planState: null, releaseName: null, ...over });
const option = (over: Partial<RevisionOption> = {}): RevisionOption => ({ id: "rev-1", name: "moss-lag-fixes", state: "open", packageName: "moss", toAddress: 1, linked: 0, updatedAt: new Date("2026-11-18T10:00:00Z"), ...over });

async function seed(key: string, kind: "diagnosis" | "fix", ordinal: number, state: "proposed" | "accepted" | "rejected", values: Record<string, unknown>, extra: { citations?: unknown[]; title?: string } = {}) {
  const title = extra.title ?? (kind === "diagnosis" ? `INCIDENT-9: ${String(values.one_line)}` : String(values.fix).slice(0, 297) + (String(values.fix).length > 300 ? "..." : ""));
  const [row] = await db()
    .insert(findings)
    .values({
      auditId,
      auditItemId: itemId,
      reviewId: ids.review!,
      spaceId: space.id,
      incidentId: "INCIDENT-9",
      kind,
      ordinal,
      title,
      proposed: values,
      current: values,
      citations: (extra.citations ?? [{ record: 12, quote: "the cache path is healthy", field: `fixes[${ordinal}].evidence[0]`, ok: true }]) as never,
      state,
      reviewNote: state === "rejected" ? "Not the cause." : null,
      reviewedBy: state === "proposed" ? null : "reviewer@example.com",
      reviewedAt: state === "proposed" ? null : new Date("2026-11-18T11:00:00Z"),
    })
    .returning({ id: findings.id });
  ids[key] = row!.id;
}

beforeAll(async () => {
  await truncateAll();
  const [a] = await db().insert(agentSpaces).values({ alias: "fd-space", region: "us-west-2", accountId: "111122223333", agentSpaceId: "space-fd" }).returning();
  const [b] = await db().insert(agentSpaces).values({ alias: "fd-other", region: "us-west-2", accountId: "111122223333", agentSpaceId: "space-fd-2" }).returning();
  space = a! as Space;
  other = b! as Space;
  const [au] = await db().insert(audits).values({ spaceId: space.id, name: "Detail audit", profileId: "benchmark", profileSnapshot: profile, policyDigest: policy.digest, state: "reviewing", createdBy: "alex@example.com" }).returning();
  auditId = au!.id;
  const [item] = await db().insert(auditItems).values({ auditId, spaceId: space.id, taskId: "task-9", incidentId: "INCIDENT-9", journalSha256: "9".repeat(64), state: "reviewed" }).returning();
  itemId = item!.id;
  const [rev] = await db()
    .insert(reviews)
    .values({ auditId, auditItemId: itemId, spaceId: space.id, runner: "ai-sdk", modelId: "test-model", promptDigest: "d".repeat(64), state: "succeeded", schemaValid: true, startedBy: "alex@example.com", startedAt: new Date("2026-11-18T09:00:00Z") })
    .returning();
  ids.review = rev!.id;
  await db().update(auditItems).set({ currentReviewId: rev!.id }).where(eq(auditItems.id, itemId));
  await seed("diag", "diagnosis", 0, "proposed", { primary_failure_mode: "D_wrong_component", failure_modes: ["D_wrong_component"], reachability: "reachable", reachability_reason: "Queryable.", near_miss: null, scorecard_fair: "yes", scorecard_notes: "", one_line: "Blamed the gateway." });
  await seed("memory", "fix", 0, "accepted", { owner: "customer_memory", fix: LONG_FIX, evidence: [{ record: 12, quote: "the cache path is healthy" }] });
  await seed("access", "fix", 1, "proposed", { owner: "customer_access", fix: "Document the metrics data source for the cache.", evidence: [] }, { citations: [{ record: 43, quote: "data source", field: "fixes[1].evidence[0]", ok: false, problem: "missing-record" }] });
  await seed("rejected", "fix", 2, "rejected", { owner: "customer_memory", fix: "Not needed.", evidence: [] });
  await seed("instr", "fix", 3, "accepted", { owner: "instructions", fix: "Require two checks.", evidence: [] });
});

beforeEach(() => {
  r.links = new Map();
  r.options = [];
  r.list = [];
  r.sources = new Map();
  r.linksFail = false;
  r.optionsFail = false;
  r.listFail = false;
  r.asked = [];
});

describe("the finding detail", () => {
  it("shows the whole finding: the full title, the profile's labels and each citation with its check result", async () => {
    const d = (await loadFindingDetail(space, auditId, ids.memory!, editor))!;
    expect(d.finding.title.length).toBeLessThanOrEqual(300);
    expect(d.finding.title.endsWith("...")).toBe(true);
    expect(d.finding.fullTitle).toBe(LONG_FIX.replace(/\s+/g, " "));
    expect(d.finding.fullTitle.length).toBeGreaterThan(300);
    expect(d.finding).toMatchObject({ kindLabel: "Fix", incidentId: "INCIDENT-9", itemId, state: "accepted" });
    expect(d.finding.fields.map((f) => [f.key, f.label])).toEqual([
      ["owner", "Owner"],
      ["fix", "Fix"],
      ["evidence", "Evidence"],
    ]);
    expect(d.finding.fields.find((f) => f.key === "owner")).toMatchObject({ value: "customer_memory", valueLabel: "Customer memory or runbook content" });
    expect(d.finding.citations).toEqual([expect.objectContaining({ record: 12, quote: "the cache path is healthy", ok: true, recordId: null, href: null })]);
    expect(d.sibling).toEqual({ index: 0, count: 4 });
    expect(d.taskId).toBe("task-9");
  });

  it("places a finding among the findings of its kind", async () => {
    expect((await loadFindingDetail(space, auditId, ids.instr!, editor))!.sibling).toEqual({ index: 3, count: 4 });
    expect((await loadFindingDetail(space, auditId, ids.diag!, editor))!.sibling).toEqual({ index: 0, count: 1 });
  });

  it("gives an Editor the decision buttons and a Viewer none", async () => {
    const proposed = (await loadFindingDetail(space, auditId, ids.diag!, editor))!.finding.actions;
    expect(proposed.accept.enabled).toBe(true);
    expect(proposed.reject.enabled).toBe(true);
    expect(proposed.edit.enabled).toBe(true);
    const asViewer = (await loadFindingDetail(space, auditId, ids.diag!, viewer))!.finding.actions;
    expect(asViewer.accept).toEqual({ enabled: false, disabledReason: "Your role can't review findings in this space." });
  });

  it("keeps a rejected finding's note", async () => {
    const d = (await loadFindingDetail(space, auditId, ids.rejected!, editor))!.finding;
    expect(d).toMatchObject({ state: "rejected", reviewNote: "Not the cause.", reviewedBy: "reviewer@example.com" });
  });

  it("is only found in its own audit and space", async () => {
    expect(await loadFindingDetail(other, auditId, ids.diag!, editor)).toBeNull();
    expect(await loadFindingDetail(space, "00000000-0000-4000-8000-000000000999", ids.diag!, editor)).toBeNull();
    expect(await loadFindingDetail(space, auditId, "not-a-uuid", editor)).toBeNull();
    expect(await loadFindingDetail(space, auditId, "00000000-0000-4000-8000-000000000999", editor)).toBeNull();
  });
});

describe("where the fixes go", () => {
  const audit = async () => profileOf((await db().select().from(audits))[0]!);

  it("sorts the findings into recorded, package and action, and reads where the package fixes went", async () => {
    r.links = new Map([[ids.memory!, [link()]]]);
    r.options = [option()];
    const ctx = await loadFixContext(space.id, auditId, await audit(), { canBuild: true });
    expect(ctx.fixes.map((f) => [f.kind, f.state, f.nature.kind])).toEqual([
      ["diagnosis", "proposed", "recorded"],
      ["fix", "accepted", "package"],
      ["fix", "proposed", "action"],
      ["fix", "rejected", "package"],
      ["fix", "accepted", "package"],
    ]);
    expect(r.asked.find((a) => a.fn === "links")!.ids!.sort()).toEqual([ids.memory!, ids.rejected!, ids.instr!].sort());
    expect(ctx.links!.get(ids.memory!)).toEqual([link()]);
    expect(ctx.options).toEqual([option()]);
    // Two accepted package fixes; one is in a revision, the other isn't.
    expect(ctx.progress).toEqual({ total: 2, inRevision: 1, applied: 0, open: [ids.instr!] });
  });

  it("tells the revisions apart: base, who started it, its audits, how far it got, and how many of this audit's fixes it holds", async () => {
    // The accepted fix and the rejected one are both in rev-1; only the accepted one counts as a fix of this audit in it.
    r.links = new Map([
      [ids.memory!, [link()]],
      [ids.rejected!, [link()]],
    ]);
    r.options = [option()];
    r.list = [{ id: "rev-1", name: "moss-lag-fixes", state: "open", changes: 2, plan: null, base: { label: "v2.4" }, createdBy: "sam@example.com", createdAt: new Date("2026-11-17T09:00:00Z"), toAddress: 1, linkedFindings: 0 }];
    r.sources = new Map([["rev-1", [{ auditId, auditName: "Detail audit", findings: 1 }]]]);
    const ctx = await loadFixContext(space.id, auditId, await audit(), { canBuild: true });
    expect(ctx.revisions.get("rev-1")).toMatchObject({
      name: "moss-lag-fixes",
      stage: { stage: "saved", words: "Saved, no plan yet" },
      base: "v2.4",
      createdBy: "sam@example.com",
      audits: [{ auditId, auditName: "Detail audit", findings: 1 }],
      fromThisAudit: 1,
    });
  });

  it("counts a fix as applied when its revision's plan was applied", async () => {
    r.links = new Map([[ids.memory!, [link({ kind: "linked", planId: "p1", planState: "applied" })]], [ids.instr!, [link()]]]);
    const ctx = await loadFixContext(space.id, auditId, await audit(), { canBuild: false });
    expect(ctx.progress).toEqual({ total: 2, inRevision: 2, applied: 1, open: [] });
  });

  it("still loads the audit when the details of the revisions can't be read", async () => {
    r.links = new Map([[ids.memory!, [link()]]]);
    r.listFail = true;
    const err = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const ctx = await loadFixContext(space.id, auditId, await audit(), { canBuild: false });
    expect(ctx.revisions.size).toBe(0);
    expect(ctx.progress.inRevision).toBe(1);
    expect(err).toHaveBeenCalledTimes(1);
    err.mockRestore();
  });

  it("gives the page the words for each finding", async () => {
    r.links = new Map([[ids.memory!, [link({ kind: "linked", planId: "p1", planState: "applied", releaseName: "v2.4" })]]]);
    const ctx = await loadFixContext(space.id, auditId, await audit(), { canBuild: true });
    const sent = nextStepFor({ state: "accepted", nature: ctx.natures.get(ids.memory!)!, canDecide: true, canBuild: true, links: ctx.links!.get(ids.memory!) ?? [], reviewNote: null });
    expect(sent.rule).toBe("package-sent");
    const open = nextStepFor({ state: "accepted", nature: ctx.natures.get(ids.instr!)!, canDecide: true, canBuild: true, links: ctx.links!.get(ids.instr!) ?? [], reviewNote: null });
    expect(open.action?.label).toBe("Add to revision…");
    const access = nextStepFor({ state: "proposed", nature: ctx.natures.get(ids.access!)!, canDecide: true, canBuild: true, links: [], reviewNote: null });
    expect(access.text).toContain("action for Customer tool or data access");
  });

  it("doesn't read the open revisions for someone who can't build", async () => {
    r.options = [option()];
    const ctx = await loadFixContext(space.id, auditId, await audit(), { canBuild: false });
    expect(ctx.options).toEqual([]);
    expect(r.asked.some((a) => a.fn === "options")).toBe(false);
  });

  it("still loads the audit when the revisions can't be read", async () => {
    r.linksFail = true;
    r.optionsFail = true;
    const err = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const ctx = await loadFixContext(space.id, auditId, await audit(), { canBuild: true });
    expect(ctx.links).toBeNull();
    expect(ctx.options).toEqual([]);
    expect(ctx.progress).toEqual({ total: 2, inRevision: null, applied: null, open: [] });
    expect(ctx.fixes).toHaveLength(5);
    expect(err).toHaveBeenCalledTimes(2);
    err.mockRestore();
  });
});
