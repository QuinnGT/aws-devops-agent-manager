import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { deflateRawSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { getAppPolicy, type Policy } from "@/server/policy";
import { ValidationFailure } from "@/server/validation/types";
import { comparePaths, globToRegExp, pathProblem, resolveRelative } from "./paths";
import { readPackage, readPackageFiles, readPackageZip } from "./read";
import { readZip, writeZip, type ZipReadLimits } from "./zip";

const policy = getAppPolicy().policy;
const L: ZipReadLimits = { maxZipBytes: 1_000_000, maxEntries: 10, maxEntryBytes: 100_000, maxTotalBytes: 200_000, maxPathLength: 100 };
const b = (s: string) => Buffer.from(s, "utf8");

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
function centralOffset(zip: Buffer): number {
  return zip.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
}
function rejected(zip: Buffer, limits = L): string {
  const r = readZip(zip, limits);
  expect(r.entries).toEqual([]);
  expect(r.problems).toHaveLength(1);
  return r.problems[0]!.message;
}

describe("zip writer", () => {
  it("is deterministic and round-trips", () => {
    const entries = [
      { name: "pkg/a.md", data: b("hello ".repeat(50)) },
      { name: "pkg/b/ü.md", data: b("x") },
      { name: "pkg/empty.md", data: Buffer.alloc(0) },
    ];
    const one = writeZip(entries);
    expect(writeZip(entries).equals(one)).toBe(true);
    const { entries: back, problems } = readZip(one, L);
    expect(problems).toEqual([]);
    expect(back.map((e) => [e.name, e.data.toString()])).toEqual(entries.map((e) => [e.name, e.data.toString()]));
  });

  it("refuses unsafe names", () => {
    expect(() => writeZip([{ name: "../x", data: b("x") }])).toThrow(/'\.\.'/);
  });
});

describe("zip reader safety", () => {
  const safe = writeZip([{ name: "aaa/b.md", data: b("abc") }]);

  it("rejects absolute paths, '..' segments and backslashes", () => {
    expect(rejected(rename(safe, "aaa/b.md", "/aa/b.md"))).toMatch(/absolute path/);
    expect(rejected(rename(safe, "aaa/b.md", "../x.md "))).toMatch(/'\.\.' segment/);
    expect(rejected(rename(safe, "aaa/b.md", "aa\\b.md "))).toMatch(/backslash/);
    expect(rejected(rename(safe, "aaa/b.md", "C:/a/b.m"))).toMatch(/absolute path/);
  });

  it("rejects symlinks and special files", () => {
    const link = Buffer.from(safe);
    link.writeUInt32LE((0o120777 << 16) >>> 0, centralOffset(link) + 38);
    expect(rejected(link)).toMatch(/symbolic link/);
    const fifo = Buffer.from(safe);
    fifo.writeUInt32LE((0o010644 << 16) >>> 0, centralOffset(fifo) + 38);
    expect(rejected(fifo)).toMatch(/not a regular file/);
  });

  it("caps entries, entry size, total size and archive size", () => {
    const eleven = writeZip(Array.from({ length: 11 }, (_, i) => ({ name: `f${i}`, data: b("x") })));
    expect(rejected(eleven)).toMatch(/11 entries; the limit is 10/);
    const big = writeZip([{ name: "big", data: Buffer.alloc(150) }]);
    expect(rejected(big, { ...L, maxEntryBytes: 100 })).toMatch(/150 bytes; the limit is 100/);
    const two = writeZip([{ name: "a", data: Buffer.alloc(80) }, { name: "b", data: Buffer.alloc(80) }]);
    expect(rejected(two, { ...L, maxTotalBytes: 100 })).toMatch(/total more than 100/);
    expect(rejected(two, { ...L, maxZipBytes: 50 })).toMatch(/the limit is 50/);
  });

  it("rejects entries that inflate past their declared size (zip bombs)", () => {
    const bomb = writeZip([{ name: "z", data: Buffer.alloc(100_000) }]);
    const c = centralOffset(bomb);
    bomb.writeUInt32LE(10, c + 24);
    bomb.writeUInt32LE(10, 22);
    expect(rejected(bomb)).toMatch(/corrupt or larger than its header says/);
  });

  it("rejects corrupt data, duplicate names and non-zips", () => {
    const corrupt = Buffer.from(safe);
    const at = 30 + "aaa/b.md".length; // first stored data byte
    corrupt[at] = corrupt[at]! ^ 0xff;
    expect(rejected(corrupt)).toMatch(/CRC mismatch/);
    const dup = rename(writeZip([{ name: "a1", data: b("x") }, { name: "a2", data: b("y") }]), "a2", "a1");
    expect(rejected(dup)).toMatch(/more than once/);
    expect(rejected(b("not a zip at all, just text"))).toMatch(/not a zip/);
    expect(deflateRawSync(b("x")).length).toBeGreaterThan(0);
  });
});

describe("readPackage", () => {
  it("reads a zip from inside its single top folder and drops ignored files", async () => {
    const zip = writeZip([
      { name: "__MACOSX/pkg/._README.md", data: b("x") },
      { name: "pkg/.DS_Store", data: b("x") },
      { name: "pkg/README.md", data: b("# r") },
      { name: "pkg/skills/a/SKILL.md", data: b("# a") },
    ]);
    const p = await readPackage(zip);
    expect(p.name).toBe("pkg");
    expect([...p.files.keys()]).toEqual(["README.md", "skills/a/SKILL.md"]);
  });

  it("throws ValidationFailure for an unsafe zip", () => {
    const zip = rename(writeZip([{ name: "aa/x", data: b("x") }]), "aa/x", "../x");
    expect(() => readPackageZip(zip, "evil.zip")).toThrow(ValidationFailure);
  });

  it("reads a folder and rejects symlinks inside it", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "dam-pkg-read-"));
    mkdirSync(path.join(dir, "instructions"));
    writeFileSync(path.join(dir, "instructions", "global.md"), "# g\n");
    writeFileSync(path.join(dir, ".DS_Store"), "x");
    const ok = await readPackage(dir);
    expect(ok.name).toBe(path.basename(dir));
    expect([...ok.files.keys()]).toEqual(["instructions/global.md"]);

    symlinkSync("/etc/hosts", path.join(dir, "instructions", "hosts.md"));
    const err = await readPackage(dir).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ValidationFailure);
    expect((err as ValidationFailure).results.map((r) => r.code)).toEqual(["package.symlink"]);
  });

  it("applies the file count cap from limits.yaml", async () => {
    const capped: Policy = { ...policy, limits: { ...policy.limits, packageRead: { ...policy.limits.packageRead, maxEntries: 1 } } };
    const dir = mkdtempSync(path.join(tmpdir(), "dam-pkg-cap-"));
    writeFileSync(path.join(dir, "a.md"), "a");
    writeFileSync(path.join(dir, "b.md"), "b");
    await expect(readPackage(dir, { policy: capped })).rejects.toThrow(ValidationFailure);
    expect(() => readPackageFiles([{ path: "/etc/x", data: b("x") }], "upload")).toThrow(ValidationFailure);
  });
});

describe("paths", () => {
  it("classifies unsafe paths", () => {
    expect(pathProblem("a/b.md")).toBeNull();
    expect(pathProblem("dir/")).toBeNull();
    expect(pathProblem("a//b")).toBe("empty-segment");
    expect(pathProblem("./a")).toBe("dot-segment");
    expect(pathProblem("a/\u0001")).toBe("control-character");
    expect(resolveRelative("memory/s", "./a/b.md")).toBe("memory/s/a/b.md");
    expect(resolveRelative("memory/s", "../../../x")).toBeNull();
  });

  it("sorts like Python's sorted(Path.rglob()) and matches globs", () => {
    expect(["a-b", "a/b", "a", "B"].sort(comparePaths)).toEqual(["B", "a", "a/b", "a-b"]);
    expect(globToRegExp("**/.DS_Store").test("x/y/.DS_Store")).toBe(true);
    expect(globToRegExp("**/.DS_Store").test(".DS_Store")).toBe(true);
    expect(globToRegExp("reference/**").test("reference/a/b.md")).toBe(true);
    expect(globToRegExp("*.md").test("a/b.md")).toBe(false);
  });
});
