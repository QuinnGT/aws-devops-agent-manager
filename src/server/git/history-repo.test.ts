import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { simpleGit } from "simple-git";
import { afterAll, describe, expect, it } from "vitest";
import { resetEnvForTests } from "@/server/env";
import { HistoryRepo } from "./history-repo";

describe("HistoryRepo.open", () => {
  // These run real git processes (init, clone, commit, push); under a loaded machine
  // they took over vitest's 5 s default, so they get a timeout that fits real git.
  const GIT_TIMEOUT_MS = 30_000;
  const root = mkdtempSync(path.join(tmpdir(), "dam-history-"));
  resetEnvForTests({ ...process.env, DAM_PROCESS: "worker", DAM_DATA_DIR: path.join(root, "data") });
  afterAll(() => resetEnvForTests());

  it("uses the configured branch when cloning an empty remote whose default is another name", async () => {
    const remote = path.join(root, "remote.git");
    await simpleGit().raw(["-c", "init.defaultBranch=master", "init", "--bare", remote]);

    const repo = await HistoryRepo.open({
      id: "r1",
      name: "empty-remote",
      remoteUrl: remote,
      deployKeyFile: null,
      defaultBranch: "main",
      pushEnabled: true,
    });
    const commit = await repo.writeAndCommit([{ path: "a.txt", content: "a\n" }], {
      message: "first",
      author: { name: "t", email: "t@example.com" },
      committer: { name: "t", email: "t@example.com" },
      date: new Date("2026-11-11T00:00:00Z"),
    });
    expect(commit).toMatch(/^[0-9a-f]{40}$/);
    expect((await simpleGit(repo.dir).raw(["symbolic-ref", "--short", "HEAD"])).trim()).toBe("main");

    expect(await repo.unpushedCommitCount()).toBe(1);

    expect(await repo.push()).toBe(true);
    expect((await simpleGit(remote).raw(["rev-parse", "refs/heads/main"])).trim()).toBe(commit);
    expect(await repo.unpushedCommitCount()).toBe(0);
  }, GIT_TIMEOUT_MS);

  it("counts every commit as unpushed when the repository has no remote", async () => {
    const repo = await HistoryRepo.open({ id: "r2", name: "local-only", remoteUrl: null, deployKeyFile: null, defaultBranch: "main", pushEnabled: false });
    expect(await repo.unpushedCommitCount()).toBe(0);
    for (const n of [1, 2]) {
      await repo.writeAndCommit([{ path: `f${n}.txt`, content: `${n}\n` }], {
        message: `commit ${n}`,
        author: { name: "t", email: "t@example.com" },
        committer: { name: "t", email: "t@example.com" },
        date: new Date("2026-11-11T00:00:00Z"),
      });
    }
    expect(await repo.unpushedCommitCount()).toBe(2);
  }, GIT_TIMEOUT_MS);
});
