import { eq } from "drizzle-orm";
import { listLinkableFindings } from "@/server/audits/linkable";
import { db } from "@/server/db/client";
import * as schema from "@/server/db/schema";
import type { HistoryRepo } from "@/server/git/history-repo";
import { testJobContext } from "@/server/jobs/registry";
import type { Policy } from "@/server/policy";
import type { SyncSpaceFn } from "@/server/releases/sync-first";
import { createRevisionHandler, prepareCreateRevision } from "@/server/revisions/create";
import { readRevisionPackage } from "@/server/revisions/package-files";
import { prepareSaveRevision, saveRevisionHandler } from "@/server/revisions/save";
import { abandonRevision, createPlanFromRevision } from "@/server/revisions/service";
import type { Space } from "@/server/spaces/queries";
import { logger, type SeedPerson } from "../lib/common";
import { packageText, type SamplePackages } from "./content";
import { REPORT_NAMES } from "./reports";

/**
 * The revision pages' part of the demo. From a
 * release of the space, five revisions that make the changes the late October
 * audit asked for (they follow from the benchmark findings, and package v2 has
 * the finished versions):
 *
 *   ruleout-rules  three saves, the last build fails
 *   vendor-first      two saves, the build passes
 *   pricing-memory    one save, then a plan from it
 *   live-changes      from the live space, no saves yet
 *   old-scope         abandoned
 *
 * Saves link accepted audit findings through `link`. The create and save job
 * handlers run directly with testJobContext().
 */

const log = logger("revisions");

export type FindingKind = "diagnosis" | "fix";
/** The accepted finding a save links for this incident and kind, if there is one. `about` picks the one whose title contains that text (a fix names the asset it changes). */
export type FindingLink = (incidentId: string, kind: FindingKind, about?: string) => string | undefined;
type CreatePlan = NonNullable<Parameters<typeof createPlanFromRevision>[4]>["createPlan"];

/** Fake sync for a live revision when no mocked Agent Space is installed: the history repository is already current. */
export const noSync = (async (spaceId: string) => ({ spaceId, mode: "reconcile", status: "succeeded", listed: 0, changedAssets: 0, changes: 0, commits: 0, deferred: 0, deleted: 0, attributionFailed: false, pushed: false })) as unknown as SyncSpaceFn;

/**
 * Links to the accepted findings of the audits in this space: the same incident
 * and kind when there is one, else another accepted finding of that kind,
 * preferring the incidents linked most recently (the same save's diagnosis).
 */
export async function acceptedFindingLink(spaceId: string): Promise<FindingLink> {
  const all = (await listLinkableFindings(spaceId, { limit: 500 })).sort((a, b) => Number(b.auditName === REPORT_NAMES.main) - Number(a.auditName === REPORT_NAMES.main));
  const chosen = new Map<string, string | undefined>();
  const used = new Set<string>();
  const recent: string[] = [];
  return (incidentId, kind, about) => {
    const key = `${incidentId}:${kind}:${about ?? ""}`;
    if (!chosen.has(key)) {
      const exact = all.find((x) => x.incidentId === incidentId && x.kind === kind && (!about || x.title.includes(about)));
      const near = recent.map((inc) => all.find((x) => x.incidentId === inc && x.kind === kind && !used.has(x.id))).find(Boolean);
      const f = exact ?? near ?? all.find((x) => x.kind === kind && !used.has(x.id)) ?? all.find((x) => x.kind === kind);
      if (f) used.add(f.id);
      if (exact) recent.unshift(incidentId);
      chosen.set(key, f?.id);
    }
    return chosen.get(key);
  };
}

// ---------- revisions ----------

const ONSET = `## Find the onset before searching for changes

Find the step in the affected metric's own history before you
search for deploys, flags or config changes. The alert time is
when someone noticed, not when the fault began.

1. Query the affected metric over 14 days, not the day before.
   A baseline that already contains the fault looks normal.
2. When the onset is earlier than the alert, move the change
   search to the onset window.
3. Search adjacent 24-hour windows of the change feed back to
   the onset, weekends included. One window is not a full search.`;

const RULING_OUT = `## Do not rule a component out too early

- HTTP 200 with flat latency does not clear a cache-backed path.
  Check evicted_keys and used_memory first.
- A deploy near the alert is a hypothesis. It explains the
  incident only if the changed component is on the failing
  request path and the failure started after the change.
- An empty change feed means "unknown", not "no change".`;

/** Insert text after the first line that matches, or at the end. */
function insertAfter(text: string, marker: RegExp, add: string): string {
  const lines = text.split("\n");
  const i = lines.findIndex((l) => marker.test(l));
  if (i < 0) return `${text.replace(/\n*$/, "\n")}\n${add}\n`;
  lines.splice(i + 1, 0, "", add);
  return lines.join("\n");
}

/** The package files the revisions edit (all of them are in package v1 and v2). */
export const TARGETS = {
  rca: "instructions/incident-rca.md",
  global: "instructions/global.md",
  vendorSkill: "skills/vendor-status-check/SKILL.md",
  cacheSkill: "skills/cache-path-check/SKILL.md",
  pricingMemory: "memory/incident-patterns/patterns/pricing-mismatch.md",
  readme: "README.md",
} as const;

/** The safety response the failing save removes from the global instructions. */
const SAFETY_RESPONSE = "[DATA REDACTED]: The request contains credentials or personal data and was not processed.";

export interface RevisionSeedInput {
  space: Space;
  repo: HistoryRepo;
  /** The space's policy, with its overlay */
  policy: Policy;
  /** The sample packages: v1 is what the revisions start from, v2 supplies the finished text of the pricing memory */
  packages: SamplePackages;
  /** The package layout of the revisions: the one of the release they start from (anycompany-v1, from the sample policy overlay) */
  layoutName: string;
  /** The release the revisions start from */
  releaseId: string;
  link: FindingLink;
  people: { owner: SeedPerson; sam: SeedPerson };
  /** Sync before the live revision (default noSync) */
  sync?: SyncSpaceFn;
  /** Plan creation for pricing-memory (default: the plans module, which queues a plan check) */
  createPlan?: CreatePlan;
}

export interface RevisionScreens {
  ruleout: string;
  vendor: string;
  pricing: string;
  live: string;
  old: string;
  planId: string;
}

export async function seedRevisionScreens(o: RevisionSeedInput): Promise<RevisionScreens> {
  const { space, repo, policy, people } = o;
  const { owner: OWNER, sam: SAM } = people;
  const sync = o.sync ?? noSync;

  async function createRevision(name: string, base: { kind: "live" } | { kind: "release"; releaseId: string }, by: SeedPerson) {
    const row = await prepareCreateRevision(space, { name, base, layout: o.layoutName }, by);
    await createRevisionHandler({ revisionId: row.id }, testJobContext({ actor: { email: by.email }, spaceId: space.id }), { sync });
    return row.id;
  }

  async function headText(revisionId: string, file: string): Promise<string> {
    const [r] = await db().select().from(schema.revisions).where(eq(schema.revisions.id, revisionId));
    const pkg = await readRevisionPackage(repo, r!.headCommit!, r!.packageDir, r!.packageName);
    const data = pkg.files.get(file);
    if (!data) throw new Error(`${file} is not in revision ${r!.name}`);
    return data.toString("utf8");
  }

  const links = (...keys: [string, FindingKind, string?][]) => [...new Set(keys.map(([inc, kind, about]) => o.link(inc, kind, about)).filter((x): x is string => Boolean(x)))];

  async function save(revisionId: string, by: SeedPerson, message: string, edits: { path: string; content: string | null }[], findingIds: string[], unlinkedReason: string | null = null) {
    const reason = findingIds.length ? unlinkedReason : (unlinkedReason ?? "No accepted audit finding is available for this change.");
    const { input } = await prepareSaveRevision(space, policy, revisionId, { message, edits, findingIds, unlinkedReason: reason }, by);
    const result = await saveRevisionHandler(input, testJobContext({ actor: { email: by.email }, spaceId: space.id }));
    log(`  save "${message}": build ${result.build}${result.errors ? ` (${result.errors} errors)` : ""}`);
    return result;
  }

  const base = { kind: "release" as const, releaseId: o.releaseId };
  const T = TARGETS;

  // 1. ruleout-rules: three saves, the last one breaks the build.
  log("revision ruleout-rules");
  const ruleout = await createRevision("ruleout-rules", base, OWNER);
  await save(ruleout, OWNER, "Find the onset before searching for changes", [{ path: T.rca, content: insertAfter(await headText(ruleout, T.rca), /^# /, ONSET) }], links(["INCIDENT-20102", "diagnosis"], ["INCIDENT-20102", "fix", "change-window-search"]));
  await save(
    ruleout,
    OWNER,
    "Do not rule the cache out on HTTP status and latency",
    [
      { path: T.rca, content: `${(await headText(ruleout, T.rca)).replace(/\n*$/, "\n")}\n${RULING_OUT}\n` },
      { path: T.cacheSkill, content: `${(await headText(ruleout, T.cacheSkill)).replace(/\n*$/, "\n")}\nHTTP status and latency cannot show lost keys. Read evicted_keys, used_memory and the cluster's maxmemory-policy before you call the cache healthy.\n` },
    ],
    links(["INCIDENT-20101", "diagnosis"], ["INCIDENT-20101", "fix", "cache-path-check"]),
  );
  // Drops a safety response from the global instructions and adds a dotted tool call to a skill: two build errors.
  const global = await headText(ruleout, T.global);
  const skillText = await headText(ruleout, T.vendorSkill);
  await save(
    ruleout,
    SAM,
    "Move the handoff note into global rules",
    [
      { path: T.global, content: `${global.replace(SAFETY_RESPONSE, "Reject queries that carry personal data.")}\nThe lead lists each persisted finding before closing.\n` },
      { path: T.vendorSkill, content: `${skillText.replace(/\n*$/, "\n")}\nRun anyco_logs.search for the gateway's errors first.\n` },
    ],
    links(["INCIDENT-20104", "diagnosis"], ["INCIDENT-20104", "fix"]),
  );

  // 2. vendor-first: two saves, the build passes.
  log("revision vendor-first");
  const vendor = await createRevision("vendor-first", base, SAM);
  const skill = await headText(vendor, T.vendorSkill);
  await save(
    vendor,
    SAM,
    "Read the gateway's own TLS and auth errors before the status page",
    [{ path: T.vendorSkill, content: `${skill.replace(/\n*$/, "\n")}\n## Before the status page\n\nRead the payments-gateway's own TLS and auth errors for the incident window first.\nA deploy shortly before the failures is a hypothesis, not a cause.\n` }],
    links(["INCIDENT-20102", "diagnosis"], ["INCIDENT-20102", "fix", "vendor-status-check"]),
  );
  const readme = o.packages.v1.contents.files.has(T.readme) ? await headText(vendor, T.readme).catch(() => "# Package\n") : "# Package\n";
  await save(vendor, SAM, "Note the vendor-first change in the README", [{ path: T.readme, content: `${readme.replace(/\n*$/, "\n")}\nThe vendor-status-check skill now starts from the gateway's own TLS and auth errors.\n` }], [], "The README describes the package; no finding is behind this note.");

  // 3. pricing-memory: one save and a plan from it.
  log("revision pricing-memory");
  const pricing = await createRevision("pricing-memory", base, OWNER);
  await save(pricing, OWNER, "Say that a pricing flag can cause a price mismatch", [{ path: T.pricingMemory, content: packageText(o.packages.v2, T.pricingMemory) }], links(["INCIDENT-20106", "fix", "pricing-mismatch"], ["INCIDENT-20106", "diagnosis"]));
  const plan = await createPlanFromRevision(space, pricing, OWNER, {}, o.createPlan ? { createPlan: o.createPlan } : {});

  // 4. live-changes: from the live space, nothing saved yet.
  log("revision live-changes");
  const live = await createRevision("live-changes", { kind: "live" }, OWNER);

  // 5. old-scope: abandoned.
  log("revision old-scope");
  const old = await createRevision("old-scope", base, OWNER);
  await abandonRevision(space, old, OWNER, { note: "Superseded by ruleout-rules" });

  return { ruleout, vendor, pricing, live, old, planId: plan.planId };
}

/** The plan row written directly as "waiting for approval" (no plan job runs), for seeds without a mocked Agent Space. */
export function waitingPlan(spaceId: string, by: SeedPerson): CreatePlan {
  return async (input) => {
    const [plan] = await db()
      .insert(schema.plans)
      .values({ spaceId, title: input.title, reason: input.reason ?? null, origin: input.origin, originKind: "revision", createdBy: by.email, state: "waiting" } as typeof schema.plans.$inferInsert)
      .returning();
    return { planId: plan!.id, checkRunId: "00000000-0000-4000-8000-000000000000" };
  };
}
