import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { simpleGit } from "simple-git";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { resetEnvForTests } from "@/server/env";
import { BranchMovedError, HistoryRepo } from "@/server/git/history-repo";

// The additive HistoryRepo methods revisions use: branches that are never checked out.
const GIT_TIMEOUT_MS = 30_000;
const root = mkdtempSync(path.join(tmpdir(), "dam-rev-git-"));
const who = { name: "Alex", email: "alex@example.com" };
const date = new Date("2026-11-12T10:00:00Z");
let repo: HistoryRepo;
let main1: string;

beforeAll(async () => {
  resetEnvForTests({ ...process.env, DAM_PROCESS: "worker", DAM_DATA_DIR: path.join(root, "data") });
  repo = await HistoryRepo.open({ id: "r", name: "branches", remoteUrl: null, deployKeyFile: null, defaultBranch: "main", pushEnabled: false });
  main1 = (await repo.writeAndCommit([{ path: "spaces/s/a.txt", content: "a\n" }], { message: "first", author: who, committer: who, date }))!;
}, GIT_TIMEOUT_MS);

afterAll(() => {
  resetEnvForTests();
  rmSync(root, { recursive: true, force: true });
});

describe("revision branches", () => {
  it(
    "commits files to a branch without touching the working copy or the default branch",
    async () => {
      await repo.createBranch("revision/s/v1", main1);
      expect(await repo.branchHead("revision/s/v1")).toBe(main1);
      const icon = Buffer.from([0x89, 0x50, 0x00, 0xff, 0x0a, 0x0d]);
      const c1 = await repo.commitToBranch(
        "revision/s/v1",
        [
          { path: "packages/s/v1/README.md", content: "# Package\r\nwith CRLF\r\n" },
          { path: "packages/s/v1/skills/x.zip", content: icon },
          { path: "packages/s/v1/a b/ü.md", content: "unicode path\n" },
        ],
        { message: "Start", author: who, committer: who, date, trailers: [["Revision-Id", "r1"], ["Finding-Id", "f1"], ["Finding-Id", "f2"], ["Empty", null]], expectedHead: main1 },
      );
      expect(c1).toMatch(/^[0-9a-f]{40}$/);
      expect(await repo.head()).toBe(main1);
      expect((await simpleGit(repo.dir).raw(["status", "--porcelain"])).trim()).toBe("");
      expect((await simpleGit(repo.dir).raw(["symbolic-ref", "--short", "HEAD"])).trim()).toBe("main");

      const [entry] = await repo.log({ ref: c1!, maxCount: 1 });
      expect(entry).toMatchObject({ message: "Start", authorEmail: who.email });
      expect(entry!.body.trim().split("\n")).toEqual(["Revision-Id: r1", "Finding-Id: f1", "Finding-Id: f2"]);

      const tree = await repo.listTree(c1!, "packages/s/v1");
      expect(tree.map((t) => [t.path, t.size])).toEqual([
        ["packages/s/v1/README.md", 22],
        ["packages/s/v1/a b/ü.md", 13],
        ["packages/s/v1/skills/x.zip", 6],
      ]);
      const blobs = await repo.readBlobs(c1!, [...tree.map((t) => t.path), "packages/s/v1/missing.md"]);
      expect(blobs.get("packages/s/v1/README.md")!.toString("utf8")).toBe("# Package\r\nwith CRLF\r\n");
      expect(blobs.get("packages/s/v1/skills/x.zip")!.equals(icon)).toBe(true);
      expect(blobs.get("packages/s/v1/missing.md")).toBeNull();
      // The base tree is still there on the branch.
      expect((await repo.readBlobs(c1!, ["spaces/s/a.txt"])).get("spaces/s/a.txt")!.toString()).toBe("a\n");

      const c2 = await repo.commitToBranch(
        "revision/s/v1",
        [
          { path: "packages/s/v1/README.md", content: "# Package v2\n" },
          { path: "packages/s/v1/skills/x.zip", content: null },
        ],
        { message: "Edit", author: who, committer: who, date, expectedHead: c1 },
      );
      expect(await repo.diffNameStatus(c1!, c2!, "packages/s/v1")).toEqual([
        { status: "modified", path: "packages/s/v1/README.md" },
        { status: "deleted", path: "packages/s/v1/skills/x.zip" },
      ]);
      expect(await repo.diff(c1!, c2!, "packages/s/v1/README.md")).toContain("+# Package v2");

      // Nothing to change: no commit.
      expect(await repo.commitToBranch("revision/s/v1", [{ path: "packages/s/v1/README.md", content: "# Package v2\n" }], { message: "Same", author: who, committer: who, date })).toBeNull();
      expect(await repo.branchHead("revision/s/v1")).toBe(c2);
    },
    GIT_TIMEOUT_MS,
  );

  it(
    "refuses a commit when the branch moved, a branch that exists, and unsafe names",
    async () => {
      const head = (await repo.branchHead("revision/s/v1"))!;
      await expect(repo.commitToBranch("revision/s/v1", [{ path: "packages/s/v1/x.md", content: "x\n" }], { message: "Stale", author: who, committer: who, date, expectedHead: main1 })).rejects.toBeInstanceOf(BranchMovedError);
      expect(await repo.branchHead("revision/s/v1")).toBe(head);
      await expect(repo.createBranch("revision/s/v1", main1)).rejects.toThrow();
      await expect(repo.createBranch("revision/s/bad..name", main1)).rejects.toThrow(/branch name/);
      await expect(repo.createBranch("-x", main1)).rejects.toThrow(/unsafe/);
      await expect(repo.commitToBranch("revision/s/v1", [{ path: "../escape.md", content: "x" }], { message: "x", author: who, committer: who, date })).rejects.toThrow(/unsafe path/);
      expect(await repo.branchHead("revision/s/none")).toBeNull();
      await expect(repo.commitToBranch("revision/s/none", [], { message: "x", author: who, committer: who, date })).rejects.toThrow(/no branch/);
    },
    GIT_TIMEOUT_MS,
  );

  it(
    "keeps the working copy usable for sync commits while a branch is edited",
    async () => {
      const m2 = await repo.writeAndCommit([{ path: "spaces/s/b.txt", content: "b\n" }], { message: "sync", author: who, committer: who, date });
      expect(m2).toMatch(/^[0-9a-f]{40}$/);
      expect(await repo.head()).toBe(m2);
      expect((await repo.listTree("refs/heads/revision/s/v1", "spaces/s")).map((t) => t.path)).toEqual(["spaces/s/a.txt"]);
      expect(await repo.pushBranch("revision/s/v1")).toBe(false);
    },
    GIT_TIMEOUT_MS,
  );
});
