import { eq } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";
import { db } from "@/server/db/client";
import { agentSpaces, auditItems, audits, findings, reviews, revisionChanges, revisions } from "@/server/db/schema";
import { getAppPolicy } from "@/server/policy";
import { truncateAll } from "../../../test/helpers/db";
import { revisionAuditSources } from "./sources";

/**
 * Which audits a revision's findings come from, against a disposable
 * database. Rows are written directly: the function only reads them.
 */

const policy = getAppPolicy().policy;
let spaceId: string;
let otherSpaceId: string;
const AUDIT = { a: "", b: "" };
const F: Record<"a1" | "a2" | "a3" | "b1", string> = { a1: "", a2: "", a3: "", b1: "" };
const REV = { both: "", onlyB: "", empty: "" };

async function seedAudit(name: string): Promise<string> {
  const [audit] = await db()
    .insert(audits)
    .values({ spaceId, name, profileId: "benchmark", profileSnapshot: policy.audits.profiles.benchmark!, policyDigest: "test", state: "reviewing", createdBy: "alex@example.com" })
    .returning();
  return audit!.id;
}

async function seedFinding(auditId: string, incidentId: string): Promise<string> {
  const [item] = await db().insert(auditItems).values({ auditId, spaceId, taskId: `task-${incidentId}`, incidentId, state: "reviewed" }).returning();
  const [review] = await db().insert(reviews).values({ auditId, auditItemId: item!.id, spaceId, runner: "ai-sdk", modelId: "mock", promptDigest: "d", state: "succeeded", startedBy: "alex@example.com" }).returning();
  await db().update(auditItems).set({ currentReviewId: review!.id }).where(eq(auditItems.id, item!.id));
  const values = { owner: "instructions", fix: `Fix for ${incidentId}` };
  const [f] = await db()
    .insert(findings)
    .values({ auditId, auditItemId: item!.id, reviewId: review!.id, spaceId, incidentId, kind: "fix", ordinal: 0, title: values.fix, proposed: values, current: values, citations: [], state: "accepted", reviewedBy: "alex@example.com", reviewedAt: new Date() })
    .returning();
  return f!.id;
}

async function seedRevision(name: string, toAddress: string[]): Promise<string> {
  const [r] = await db()
    .insert(revisions)
    .values({
      spaceId,
      name,
      nameKey: name,
      branch: `revision/${name}`,
      packageDir: "package",
      packageName: name,
      layout: "default",
      baseKind: "live",
      baseRef: "HEAD",
      base: { kind: "live", label: "Live space" } as never,
      state: "open",
      toAddressFindingIds: toAddress,
      createdBy: "alex@example.com",
    })
    .returning();
  return r!.id;
}

beforeAll(async () => {
  await truncateAll();
  const [a] = await db().insert(agentSpaces).values({ alias: "src-space", region: "us-west-2", accountId: "111122223333", agentSpaceId: "space-src" }).returning();
  const [b] = await db().insert(agentSpaces).values({ alias: "src-other", region: "us-west-2", accountId: "111122223333", agentSpaceId: "space-src-2" }).returning();
  spaceId = a!.id;
  otherSpaceId = b!.id;
  AUDIT.a = await seedAudit("July audit");
  AUDIT.b = await seedAudit("June audit");
  F.a1 = await seedFinding(AUDIT.a, "INCIDENT-1");
  F.a2 = await seedFinding(AUDIT.a, "INCIDENT-2");
  F.a3 = await seedFinding(AUDIT.a, "INCIDENT-3");
  F.b1 = await seedFinding(AUDIT.b, "INCIDENT-4");
  // "both": two findings of July on its list, one of them also linked by a save, plus one of June linked by a save.
  REV.both = await seedRevision("both", [F.a1, F.a2]);
  await db()
    .insert(revisionChanges)
    .values([
      { revisionId: REV.both, spaceId, commit: "c1", parentCommit: "c0", message: "Save", findingIds: [F.a1, F.b1], buildStatus: "passed", author: "alex@example.com" },
      { revisionId: REV.both, spaceId, commit: "c2", parentCommit: "c1", message: "Save again", findingIds: [F.b1], buildStatus: "passed", author: "alex@example.com" },
    ]);
  REV.onlyB = await seedRevision("only-b", [F.b1]);
  REV.empty = await seedRevision("empty", []);
});

describe("which audits a revision's findings come from", () => {
  it("counts each finding once, whether it is on the list or linked by a save, and puts the audit with more findings first", async () => {
    const out = await revisionAuditSources(spaceId, [REV.both, REV.onlyB, REV.empty]);
    expect(out.get(REV.both)).toEqual([
      { auditId: AUDIT.a, auditName: "July audit", findings: 2 },
      { auditId: AUDIT.b, auditName: "June audit", findings: 1 },
    ]);
    expect(out.get(REV.onlyB)).toEqual([{ auditId: AUDIT.b, auditName: "June audit", findings: 1 }]);
    expect(out.get(REV.empty)).toEqual([]);
  });

  it("maps an unknown revision to an empty list, and an empty request to an empty map", async () => {
    const unknown = crypto.randomUUID();
    expect(await revisionAuditSources(spaceId, [unknown])).toEqual(new Map([[unknown, []]]));
    expect(await revisionAuditSources(spaceId, [])).toEqual(new Map());
  });

  it("doesn't read the revisions of another space", async () => {
    expect(await revisionAuditSources(otherSpaceId, [REV.both])).toEqual(new Map([[REV.both, []]]));
  });
});
