import JSZip from "jszip";
import { describe, expect, it } from "vitest";
import { getAppPolicy } from "@/server/policy";
import { HANDOFF_FORMAT, type HandoffManifest } from "./handoff";
import { cleanReviewerLabel, collectCandidates, incidentMismatch, manifestProblem, matchReview } from "./handoff-import";
import type { AuditItemRow } from "./store";

const limits = getAppPolicy().policy.audits.handoff.import;
const AUDIT = "11111111-1111-4111-8111-111111111111";
const SHA = "a".repeat(64);

const item = (n: number, over: Partial<AuditItemRow> = {}): AuditItemRow =>
  ({
    id: `00000000-0000-4000-8000-00000000000${n}`,
    auditId: AUDIT,
    taskId: `task-${n}`,
    incidentId: `INCIDENT-${n}`,
    state: "pending",
    analyzedAt: new Date(0),
    journalSha256: SHA,
    currentReviewId: null,
    ...over,
  }) as AuditItemRow;

const manifestFor = (i: AuditItemRow, over: Partial<HandoffManifest> = {}): HandoffManifest => ({
  format: HANDOFF_FORMAT,
  version: 1,
  auditId: AUDIT,
  itemId: i.id,
  taskId: i.taskId,
  incidentId: i.incidentId,
  journalSha256: i.journalSha256!,
  promptDigest: "b".repeat(64),
  profileId: "benchmark",
  runner: "handoff",
  createdAt: "2026-11-19T16:00:00.000Z",
  ...over,
});

async function zipOf(files: Record<string, string>, opts: { unixPermissions?: number; platform?: "UNIX" | "DOS" } = {}): Promise<Buffer> {
  const z = new JSZip();
  for (const [name, content] of Object.entries(files)) z.file(name, content, { createFolders: false, ...(opts.unixPermissions ? { unixPermissions: opts.unixPermissions } : {}) });
  return z.generateAsync({ type: "nodebuffer", compression: "DEFLATE", platform: opts.platform ?? "DOS" });
}

/** JSZip refuses to write some unsafe names, so write a safe name and patch the bytes. */
function renameEntry(buf: Buffer, from: string, to: string): Buffer {
  if (from.length !== to.length) throw new Error("names must have the same length");
  const out = Buffer.from(buf);
  let i = out.indexOf(from);
  while (i >= 0) {
    out.write(to, i, "latin1");
    i = out.indexOf(from, i + 1);
  }
  return out;
}

describe("cleanReviewerLabel", () => {
  it("keeps one line of text", () => {
    expect(cleanReviewerLabel("  Claude Code,\n  Opus 5.5 ", 80)).toBe("Claude Code, Opus 5.5");
  });
  it("refuses an empty or too long label, naming the field", () => {
    expect(() => cleanReviewerLabel("   ", 80)).toThrow("Enter who or what wrote the reviews");
    expect(() => cleanReviewerLabel(undefined, 80)).toThrow("Enter who or what");
    expect(() => cleanReviewerLabel("x".repeat(81), 80)).toThrow("80 characters or fewer");
    try {
      cleanReviewerLabel("", 80);
    } catch (e) {
      expect((e as { details?: { field?: string } }).details?.field).toBe("reviewer");
    }
  });
});

describe("collectCandidates", () => {
  it("reads review.json and manifest.json from each folder of a zip, and leaves the rest alone", async () => {
    const bytes = await zipOf({
      "INCIDENT-1/review.json": '{"a":1}',
      "INCIDENT-1/manifest.json": '{"m":1}',
      "INCIDENT-1/records.md": "x".repeat(100),
      "INCIDENT-2/manifest.json": "{}",
      "INCIDENT-2/brief.md": "brief",
      "audit/INCIDENT-3/review.json": '{"c":3}',
      "__MACOSX/INCIDENT-1/._review.json": "junk",
    });
    const r = await collectCandidates([{ fileName: "reviews.zip", bytes }], limits);
    expect(r.refused).toEqual([]);
    expect(r.withoutReview).toBe(1);
    expect(r.candidates.map((c) => [c.folder, c.review, c.manifest])).toEqual([
      ["INCIDENT-1", '{"a":1}', '{"m":1}'],
      ["INCIDENT-3", '{"c":3}', null],
    ]);
    expect(r.candidates[0]!.path).toBe("reviews.zip: INCIDENT-1/review.json");
  });

  it("turns a zip with an unsafe entry into one refused file, and reads nothing from it", async () => {
    const up = renameEntry(await zipOf({ "xx/review.json": "{}" }), "xx/review.json", "../review.json");
    const abs = renameEntry(await zipOf({ "xetc/review.json": "{}" }), "xetc/review.json", "/etc/review.json");
    const link = await zipOf({ "INCIDENT-1/review.json": "/etc/passwd" }, { unixPermissions: 0o120777, platform: "UNIX" });
    const r = await collectCandidates(
      [
        { fileName: "up.zip", bytes: up },
        { fileName: "abs.zip", bytes: abs },
        { fileName: "link.zip", bytes: link },
      ],
      limits,
    );
    expect(r.candidates).toEqual([]);
    expect(r.refused.map((x) => x.path)).toEqual(["up.zip", "abs.zip", "link.zip"]);
    expect(r.refused[0]!.reason).toMatch(/".." segment/);
    expect(r.refused[1]!.reason).toMatch(/absolute path/);
    expect(r.refused[2]!.reason).toMatch(/symbolic links/);
  });

  it("refuses a zip over the policy's limits", async () => {
    const small = { ...limits, maxZipEntries: 2, maxEntryBytes: 50, maxUncompressedBytes: 80 };
    const many = await zipOf({ "a/review.json": "{}", "b/review.json": "{}", "c/review.json": "{}" });
    expect((await collectCandidates([{ fileName: "m.zip", bytes: many }], small)).refused[0]!.reason).toMatch(/3 entries; the limit is 2/);
    const big = await zipOf({ "a/records.md": "x".repeat(200) });
    expect((await collectCandidates([{ fileName: "b.zip", bytes: big }], small)).refused[0]!.reason).toMatch(/larger than 50 bytes/);
    const huge = await zipOf({ "a/review.json": "y".repeat(40), "b/review.json": "y".repeat(40), "c.md": "z" });
    expect((await collectCandidates([{ fileName: "h.zip", bytes: huge }], { ...small, maxZipEntries: 5 })).refused[0]!.reason).toMatch(/add up to more than/);
  });

  it("marks a review.json larger than the review limit, and refuses a file larger than the upload limit", async () => {
    const tight = { ...limits, maxReviewBytes: 100, maxUploadBytes: 5000 };
    const bytes = await zipOf({ "INCIDENT-1/review.json": "x".repeat(300) });
    const r = await collectCandidates([{ fileName: "r.zip", bytes }], tight);
    expect(r.candidates[0]!.problem).toMatch(/larger than 1 KB/);
    const over = await collectCandidates([{ fileName: "big.json", bytes: Buffer.alloc(6000, 32) }], tight);
    expect(over.refused[0]!.reason).toMatch(/larger than/);
  });

  it("takes one loose review.json with the manifest.json beside it", async () => {
    const r = await collectCandidates(
      [
        { fileName: "review.json", bytes: Buffer.from('{"a":1}') },
        { fileName: "manifest.json", bytes: Buffer.from('\uFEFF{"m":1}') },
      ],
      limits,
    );
    expect(r.refused).toEqual([]);
    expect(r.candidates).toEqual([{ path: "review.json", folder: "", review: '{"a":1}', manifest: '{"m":1}' }]);
  });

  it("refuses several loose reviews, a lone manifest and files of another type", async () => {
    const r = await collectCandidates(
      [
        { fileName: "a.json", bytes: Buffer.from("{}") },
        { fileName: "b.json", bytes: Buffer.from("{}") },
        { fileName: "notes.txt", bytes: Buffer.from("hi") },
      ],
      limits,
    );
    expect(r.candidates).toEqual([]);
    expect(r.refused.map((x) => x.path)).toEqual(["notes.txt", "a.json", "b.json"]);
    expect(r.refused[0]!.reason).toContain("zip of the review folders or a review.json");
    const lone = await collectCandidates([{ fileName: "manifest.json", bytes: Buffer.from("{}") }], limits);
    expect(lone.refused[0]!.reason).toContain("goes with a review.json");
  });

  it("uses only the file name of an uploaded path", async () => {
    const r = await collectCandidates([{ fileName: "../../etc/passwd.txt", bytes: Buffer.from("x") }], limits);
    expect(r.refused[0]!.path).toBe("passwd.txt");
  });
});

describe("matchReview", () => {
  const items = [item(1), item(2), item(3, { incidentId: "INCIDENT-2", taskId: "task-3" })];
  const ctx = { auditId: AUDIT };

  it("matches a folder named for the incident ID or the task ID", () => {
    expect(matchReview({ folder: "INCIDENT-1", manifest: null }, items, ctx)).toMatchObject({ ok: true, item: { id: items[0]!.id }, manifest: null });
    expect(matchReview({ folder: "task-1", manifest: null }, items, ctx)).toMatchObject({ ok: true, item: { id: items[0]!.id } });
    expect(matchReview({ folder: "INCIDENT-2_task-3", manifest: null }, items, ctx)).toMatchObject({ ok: true, item: { id: items[2]!.id } });
  });

  it("says why a folder matches nothing, or more than one investigation", () => {
    expect(matchReview({ folder: "INCIDENT-9", manifest: null }, items, ctx)).toMatchObject({ ok: false, reason: expect.stringContaining('matches the folder "INCIDENT-9"') });
    expect(matchReview({ folder: "INCIDENT-2", manifest: null }, items, ctx)).toMatchObject({ ok: false, reason: expect.stringContaining("More than one investigation") });
    expect(matchReview({ folder: "", manifest: null }, items, ctx)).toMatchObject({ ok: false, reason: expect.stringContaining("not in a folder") });
  });

  it("matches by the manifest before the folder name", () => {
    const m = manifestFor(items[1]!);
    const r = matchReview({ folder: "whatever", manifest: JSON.stringify(m) }, items, ctx);
    expect(r).toMatchObject({ ok: true, item: { id: items[1]!.id }, manifest: { itemId: items[1]!.id } });
  });

  it("refuses a manifest that is not valid, or made for another audit or investigation", () => {
    expect(matchReview({ folder: "INCIDENT-1", manifest: "{not json" }, items, ctx)).toMatchObject({ ok: false, reason: expect.stringContaining("not valid JSON") });
    expect(matchReview({ folder: "INCIDENT-1", manifest: JSON.stringify({ format: "other" }) }, items, ctx)).toMatchObject({ ok: false, reason: expect.stringContaining("not a manifest this app wrote") });
    const other = manifestFor(items[0]!, { auditId: "22222222-2222-4222-8222-222222222222" });
    expect(matchReview({ folder: "INCIDENT-1", manifest: JSON.stringify(other) }, items, ctx)).toMatchObject({ ok: false, reason: expect.stringContaining("different audit") });
    const gone = manifestFor(items[0]!, { itemId: "33333333-3333-4333-8333-333333333333" });
    expect(matchReview({ folder: "INCIDENT-1", manifest: JSON.stringify(gone) }, items, ctx)).toMatchObject({ ok: false, reason: expect.stringContaining("not in this audit") });
  });

  it("refuses a manifest whose journal digest is not the item's current one", () => {
    const stale = manifestFor(items[0]!, { journalSha256: "c".repeat(64) });
    const r = matchReview({ folder: "INCIDENT-1", manifest: JSON.stringify(stale) }, items, ctx);
    expect(r).toMatchObject({ ok: false, reason: expect.stringContaining("The journal changed after these review files were made") });
  });

  it("keeps an upload for one investigation to that investigation", () => {
    const own = { auditId: AUDIT, itemId: items[0]!.id };
    expect(matchReview({ folder: "", manifest: null }, items, own)).toMatchObject({ ok: true, item: { id: items[0]!.id } });
    expect(matchReview({ folder: "", manifest: JSON.stringify(manifestFor(items[0]!)) }, items, own)).toMatchObject({ ok: true });
    expect(matchReview({ folder: "", manifest: JSON.stringify(manifestFor(items[1]!)) }, items, own)).toMatchObject({ ok: false, reason: "These review files are for INCIDENT-2, not for INCIDENT-1." });
    expect(matchReview({ folder: "", manifest: null }, items, { auditId: AUDIT, itemId: "44444444-4444-4444-8444-444444444444" })).toMatchObject({ ok: false });
  });
});

describe("manifestProblem and incidentMismatch", () => {
  it("passes a manifest that fits", () => {
    expect(manifestProblem(manifestFor(item(1)), AUDIT, item(1))).toBeNull();
  });
  it("names the first thing that does not fit", () => {
    expect(manifestProblem(manifestFor(item(1)), AUDIT, item(2))).toContain("different investigation");
    expect(manifestProblem(manifestFor(item(1)), AUDIT, item(1, { journalSha256: "d".repeat(64) }))).toContain("journal changed");
  });
  it("compares the review's own incident field with the matched investigation", () => {
    expect(incidentMismatch({ incident: "incident-1" }, item(1))).toBeNull();
    expect(incidentMismatch({ incident: "INCIDENT-7" }, item(1))).toBe("INCIDENT-7");
    expect(incidentMismatch({ one_line: "x" }, item(1))).toBeNull();
    expect(incidentMismatch({ incident: "INCIDENT-7" }, item(1, { incidentId: null }))).toBeNull();
    expect(incidentMismatch(["x"], item(1))).toBeNull();
  });
});
