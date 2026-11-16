import { describe, expect, it } from "vitest";
import { zipPackage } from "@/server/packages/build";
import { getLayout } from "@/server/packages/layout";
import { packageFromFiles } from "@/server/packages/read";
import { writeZip } from "@/server/packages/zip";
import { getAppPolicy, type Policy } from "@/server/policy";
import { sha256Hex } from "@/server/sync/content";
import { displayName, readStoredUpload, readUpload, type ReadUploadResult } from "./upload";

const policy = getAppPolicy().policy;
const layout = getLayout(policy, "instruction-folders-shared");
const b = (s: string) => Buffer.from(s, "utf8");

function withLimits(over: Partial<Policy["limits"]["packageRead"]>): Policy {
  return { ...policy, limits: { ...policy.limits, packageRead: { ...policy.limits.packageRead, ...over } } };
}

/** Rename an entry in place (local and central header); same byte length only. */
function rename(zip: Buffer, from: string, to: string): Buffer {
  expect(to.length).toBe(from.length);
  const out = Buffer.from(zip);
  let i = out.indexOf(from);
  while (i >= 0) {
    out.write(to, i, "latin1");
    i = out.indexOf(from, i + 1);
  }
  return out;
}

const demo = () =>
  packageFromFiles("demo", {
    "README.md": "# Demo\n",
    "instructions/global.md": "# Global\n",
    "skills/demo-skill/SKILL.md": "---\nname: demo-skill\ndescription: Use when testing.\n---\n# Demo\n",
  });

function rejected(r: ReadUploadResult): string[] {
  expect(r.ok).toBe(false);
  return r.ok ? [] : r.results.map((x) => x.code);
}

describe("readUpload: zip", () => {
  it("reads a package zip and keeps the uploaded bytes for storage", () => {
    const bytes = zipPackage(demo());
    const r = readUpload({ kind: "zip", fileName: "C:\\Users\\me\\demo.zip", bytes }, { policy, layout });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.fileName).toBe("demo.zip");
    expect(r.source).toBe("zip");
    expect(r.sha256).toBe(sha256Hex(bytes));
    expect(r.stored.equals(bytes)).toBe(true);
    expect(r.contents.name).toBe("demo");
    expect([...r.contents.files.keys()]).toEqual(["README.md", "instructions/global.md", "skills/demo-skill/SKILL.md"]);
  });

  it("rejects '..' segments and absolute paths inside the zip", () => {
    const safe = writeZip([{ name: "aaaa/x.md", data: b("x") }]);
    const dotdot = readUpload({ kind: "zip", fileName: "a.zip", bytes: rename(safe, "aaaa/x.md", "../a/x.md") }, { policy, layout });
    expect(rejected(dotdot)).toHaveLength(1);
    if (!dotdot.ok) expect(dotdot.results[0]!.message).toMatch(/'\.\.'/);
    const absolute = readUpload({ kind: "zip", fileName: "a.zip", bytes: rename(safe, "aaaa/x.md", "/aaa/x.md") }, { policy, layout });
    expect(rejected(absolute)).toHaveLength(1);
    if (!absolute.ok) expect(absolute.results[0]!.message).toMatch(/absolute/);
  });

  it("rejects a zip over the archive size limit before reading it", () => {
    const bytes = zipPackage(demo());
    const r = readUpload({ kind: "zip", fileName: "demo.zip", bytes }, { policy: withLimits({ maxZipBytes: bytes.length - 1 }), layout });
    expect(rejected(r)).toEqual(["package.too-large"]);
    expect(r.sizeBytes).toBe(bytes.length);
    expect(r.sha256).toBe(sha256Hex(bytes));
  });

  it("rejects entries over the per-file limit", () => {
    const bytes = writeZip([{ name: "demo/README.md", data: b("x".repeat(500)) }]);
    expect(rejected(readUpload({ kind: "zip", fileName: "demo.zip", bytes }, { policy: withLimits({ maxEntryBytes: 100 }), layout })).length).toBeGreaterThan(0);
  });

  it("rejects empty files and files that are not zips", () => {
    expect(rejected(readUpload({ kind: "zip", fileName: "x.zip", bytes: Buffer.alloc(0) }, { policy, layout }))).toEqual(["package.empty"]);
    expect(rejected(readUpload({ kind: "zip", fileName: "x.zip", bytes: b("hello") }, { policy, layout }))).toEqual(["package.not-zip"]);
  });
});

describe("readUpload: folder", () => {
  const files = () => [
    { path: "revised/README.md", data: b("# Demo\n") },
    { path: "revised/instructions/global.md", data: b("# Global\n") },
    { path: "revised/.DS_Store", data: b("junk") },
  ];

  it("reads a folder upload from inside its top folder and stores a deterministic zip", () => {
    const one = readUpload({ kind: "folder", files: files() }, { policy, layout });
    const two = readUpload({ kind: "folder", files: files().reverse() }, { policy, layout });
    expect(one.ok && two.ok).toBe(true);
    if (!one.ok || !two.ok) return;
    expect(one.fileName).toBe("revised");
    expect(one.contents.name).toBe("revised");
    expect([...one.contents.files.keys()]).toEqual(["README.md", "instructions/global.md"]);
    expect(one.sha256).toBe(two.sha256);
    expect(one.sha256).toBe(sha256Hex(one.stored));
    const back = readStoredUpload(one.stored, one.contents.name, { policy, layout });
    expect(back.name).toBe("revised");
    expect([...back.files.entries()].map(([p, d]) => [p, d.toString()])).toEqual([...one.contents.files.entries()].map(([p, d]) => [p, d.toString()]));
  });

  it("rejects unsafe paths", () => {
    const codes = rejected(
      readUpload(
        {
          kind: "folder",
          files: [
            { path: "pkg/../../etc/passwd", data: b("x") },
            { path: "/etc/hosts", data: b("x") },
            { path: "pkg\\win.md", data: b("x") },
          ],
        },
        { policy, layout },
      ),
    );
    expect(codes).toEqual(["package.unsafe-path", "package.unsafe-path", "package.unsafe-path"]);
  });

  it("rejects oversize files, too many files and too many bytes", () => {
    expect(rejected(readUpload({ kind: "folder", files: files() }, { policy: withLimits({ maxEntryBytes: 5 }), layout }))).toContain("package.file-too-large");
    expect(rejected(readUpload({ kind: "folder", files: files() }, { policy: withLimits({ maxEntries: 2 }), layout }))).toContain("package.too-many-files");
    expect(rejected(readUpload({ kind: "folder", files: files() }, { policy: withLimits({ maxTotalBytes: 10 }), layout }))).toContain("package.too-large");
  });

  it("rejects an empty folder", () => {
    expect(rejected(readUpload({ kind: "folder", files: [] }, { policy, layout }))).toEqual(["package.empty"]);
    expect(rejected(readUpload({ kind: "folder", files: [{ path: "pkg/.DS_Store", data: b("x") }] }, { policy, layout }))).toEqual(["package.empty"]);
  });
});

describe("displayName", () => {
  it("keeps the base name without control characters", () => {
    expect(displayName("a/b/c\u0007.zip", "x")).toBe("c.zip");
    expect(displayName("", "fallback")).toBe("fallback");
    expect(displayName(undefined, "fallback")).toBe("fallback");
  });
});
