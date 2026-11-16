import JSZip from "jszip";
import { describe, expect, it } from "vitest";
import { getAppPolicy } from "@/server/policy";
import type { JournalBundle } from "@/lib/journal/types";
import { apiFixture } from "../../../test/helpers/fixtures";
import { buildExportZip, csvCell, EXPORT_FORMAT, investigationNames, manifestCsv } from "./export-zip";
import { toStoredExecution, toStoredRecord, toStoredTask, type RawObject } from "./normalize";
import { templateSetFor } from "./templates/load";
import { openSafeZip, readCentralDirectory, UnsafeZipError, type ZipLimits } from "./zip-safety";

/* eslint-disable @typescript-eslint/no-explicit-any */
const limits: ZipLimits = { maxEntries: 10, maxUncompressedBytes: 10_000, maxEntryBytes: 5_000 };

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

describe("zip safety", () => {
  it("accepts a normal zip and reads entries", async () => {
    const z = await openSafeZip(await zipOf({ "a/INCIDENT-1_full_journal.md": "# hi", "b.md": "x" }), limits);
    expect(z.files).toEqual(["a/INCIDENT-1_full_journal.md", "b.md"]);
    expect(await z.readText("b.md")).toBe("x");
  });

  it("rejects '..' segments (zip slip)", async () => {
    const buf = renameEntry(await zipOf({ "xx/evil.md": "x" }), "xx/evil.md", "../evil.md");
    expect(readCentralDirectory(buf)[0]?.name).toBe("../evil.md");
    await expect(openSafeZip(buf, limits)).rejects.toThrow(/".." segment/);
    const nested = renameEntry(await zipOf({ "a/xx/b.md": "x" }), "a/xx/b.md", "a/../b.md");
    await expect(openSafeZip(nested, limits)).rejects.toThrow(UnsafeZipError);
    const backslash = renameEntry(await zipOf({ "a/xx/b.md": "x" }), "a/xx/b.md", "a\\..\\b.md");
    await expect(openSafeZip(backslash, limits)).rejects.toThrow(/".." segment/);
  });

  it("rejects absolute paths", async () => {
    await expect(openSafeZip(renameEntry(await zipOf({ "xetc/passwd": "x" }), "xetc/passwd", "/etc/passwd"), limits)).rejects.toThrow(/absolute path/);
    await expect(openSafeZip(renameEntry(await zipOf({ "xxWindows": "x" }), "xxWindows", "C:Windows"), limits)).rejects.toThrow(/absolute path/);
  });

  it("rejects symbolic links", async () => {
    const buf = await zipOf({ link: "/etc/passwd" }, { unixPermissions: 0o120777, platform: "UNIX" });
    expect(readCentralDirectory(buf)[0]?.isSymlink).toBe(true);
    await expect(openSafeZip(buf, limits)).rejects.toThrow(/symbolic links/);
  });

  it("caps the entry count and sizes", async () => {
    const many = Object.fromEntries(Array.from({ length: 11 }, (_, i) => [`f${i}.md`, "x"]));
    await expect(openSafeZip(await zipOf(many), limits)).rejects.toThrow(/11 entries/);
    await expect(openSafeZip(await zipOf({ "big.md": "x".repeat(6_000) }), limits)).rejects.toThrow(/larger than 5000 bytes/);
    const total = Object.fromEntries(Array.from({ length: 3 }, (_, i) => [`f${i}.md`, "x".repeat(4_000)]));
    await expect(openSafeZip(await zipOf(total), limits)).rejects.toThrow(/add up to more than/);
  });

  it("stops reading an entry that decompresses to more than its header says", async () => {
    const buf = await zipOf({ "a.md": "y".repeat(4_000) });
    // Patch the central directory's uncompressed size down to 10 bytes.
    const cd = buf.lastIndexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
    buf.writeUInt32LE(10, cd + 24);
    const z = await openSafeZip(buf, limits);
    await expect(z.readText("a.md")).rejects.toThrow(/more than the allowed size/);
  });

  it("rejects files that are not zips", async () => {
    await expect(openSafeZip(Buffer.from("not a zip at all, just text"), limits)).rejects.toThrow(/not a zip/);
  });
});

function fixtureBundle(incidentId: string | null): JournalBundle {
  const task = toStoredTask(apiFixture<any>("GetBacklogTask").response.task, incidentId, "api");
  const exec = toStoredExecution(apiFixture<any>("ListExecutions").response.executions[0], task.taskId);
  const raws: RawObject[] = [...apiFixture<any>("ListJournalRecords.exec0.page0").response.records, ...apiFixture<any>("ListJournalRecords.exec0.page1").response.records];
  return { spaceId: "s", task, executions: [exec], records: raws.map((r, i) => toStoredRecord(r, task.taskId, i + 1)) };
}

describe("export zip", () => {
  it("contains raw JSON, markdown and a manifest per investigation", async () => {
    const a = fixtureBundle("INCIDENT-1");
    const b = { ...fixtureBundle("INCIDENT-1"), task: { ...fixtureBundle("INCIDENT-1").task, taskId: "second-task" } };
    const { zip, manifest } = buildExportZip({
      bundles: [a, b],
      templates: templateSetFor(getAppPolicy()),
      spaceAlias: "test",
      agentSpaceId: "00000000-0000-4000-8000-0000000000bb",
      exportedAt: new Date("2026-11-11T00:00:00Z"),
    });
    const back = await JSZip.loadAsync(await zip.generateAsync({ type: "nodebuffer" }));
    expect(Object.keys(back.files).filter((n) => !back.files[n]!.dir).sort()).toEqual([
      "manifest.csv",
      "markdown/INCIDENT-1-journal.md",
      "markdown/INCIDENT-1_second-task-journal.md",
      "raw/INCIDENT-1.json",
      "raw/INCIDENT-1_second-task.json",
    ]);
    const csv = await back.file("manifest.csv")!.async("string");
    expect(csv.split("\r\n")).toEqual([
      "task_id,incident_id,status,created_at,executions,record_count",
      `${a.task.taskId},INCIDENT-1,COMPLETED,2026-10-23T18:28:25.982Z,1,113`,
      "second-task,INCIDENT-1,COMPLETED,2026-10-23T18:28:25.982Z,1,113",
      "",
    ]);
    expect(manifest).toHaveLength(2);

    const raw = JSON.parse(await back.file("raw/INCIDENT-1.json")!.async("string"));
    expect(raw.format).toBe(EXPORT_FORMAT);
    expect(raw.task).toEqual(apiFixture<any>("GetBacklogTask").response.task);
    expect(raw.executions[0].execution).toEqual(apiFixture<any>("ListExecutions").response.executions[0]);
    expect(raw.executions[0].records).toHaveLength(113);
    expect(raw.executions[0].records[0]).toEqual(apiFixture<any>("ListJournalRecords.exec0.page0").response.records[0]);

    const md = await back.file("markdown/INCIDENT-1-journal.md")!.async("string");
    // Newest record first, as in the record-created export format.
    expect(md.startsWith("# Journal Log: INCIDENT-1\n\n\n---\n## Record: message\n**Created:** 2026-10-23 18:39:13.087000+00:00\n\n")).toBe(true);
    expect(md).not.toContain("## Record: utilization");
    expect(md).toContain("**Tool call:** `fs_read`");
  });

  it("names files by incident ID, then task ID, without unsafe characters", () => {
    const b = (incidentId: string | null, taskId: string) => ({ ...fixtureBundle(incidentId), task: { ...fixtureBundle(incidentId).task, incidentId, taskId } });
    expect(investigationNames([b("INC/1", "t1"), b(null, "t2"), b("../x", "t3")])).toEqual(["1", "t2", "x"]);
  });

  it("quotes CSV cells and neutralizes formulas", () => {
    expect(csvCell('a,"b"')).toBe('"a,""b"""');
    expect(csvCell("=HYPERLINK(1)")).toBe("'=HYPERLINK(1)");
    expect(manifestCsv([])).toBe("task_id,incident_id,status,created_at,executions,record_count\r\n");
  });
});
