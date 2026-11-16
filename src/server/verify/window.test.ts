import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { testJobContext, type JobDefinition } from "@/server/jobs/registry";
import { loadPolicyFromDirs } from "@/server/policy/loader";
import { z } from "zod";
import { withReadsCheckAfter } from "./auto";
import { readsWindow } from "./window";

const release = { name: "v2", createdAt: new Date("2026-11-10T12:00:00Z"), assets: [{ serviceUpdatedAt: "2026-11-09T08:00:00.000Z" }, { serviceUpdatedAt: "2026-11-01T00:00:00.000Z" }] };
const next = { name: "v3", createdAt: new Date("2026-11-12T12:00:00Z"), assets: [{ serviceUpdatedAt: "2026-11-11T09:00:00.000Z" }] };

describe("which investigations ran on a release", () => {
  it("runs from the release's creation to the next release's", () => {
    expect(readsWindow(release, next, "release-created")).toEqual({ mode: "release-created", from: release.createdAt, to: next.createdAt, nextRelease: "v3" });
    expect(readsWindow(release, null, "release-created")).toEqual({ mode: "release-created", from: release.createdAt, to: null, nextRelease: null });
  });

  it("runs from the newest asset change in the release to the newest in the next, when content-live", () => {
    expect(readsWindow(release, next, "content-live")).toEqual({ mode: "content-live", from: new Date("2026-11-09T08:00:00.000Z"), to: new Date("2026-11-11T09:00:00.000Z"), nextRelease: "v3" });
    // A next release with no newer change leaves the window open
    expect(readsWindow(release, { ...next, assets: release.assets }, "content-live")).toMatchObject({ to: null, nextRelease: null });
    // An empty manifest falls back to the creation time
    expect(readsWindow({ ...release, assets: [] }, null, "content-live").from).toEqual(release.createdAt);
  });
});

describe("policy/verify.yaml", () => {
  it("loads with the check off by default", () => {
    const { policy } = loadPolicyFromDirs([path.resolve(__dirname, "../../../policy")]);
    expect(policy.verify).toEqual({
      live: { syncFirst: true },
      reads: { maxInvestigations: 50, window: "release-created", managed: "skip", inactive: "skip", examplesPerFile: 3, versionsPerFile: 10, auto: { enabled: false, release: "latest" } },
    });
  });
});

describe("the hook after journal jobs", () => {
  const job: JobDefinition<z.ZodObject<{ n: z.ZodNumber }>, { imported: number }> = {
    name: "journals.import",
    input: z.object({ n: z.number() }),
    handler: async (input) => ({ imported: input.n }),
  };

  it("queues the check only when the job added journals, for the job's space", async () => {
    const queue = vi.fn(async () => ({ queued: true }));
    const wrapped = withReadsCheckAfter(job, (r) => r.imported > 0, queue);
    expect(wrapped.name).toBe("journals.import");
    const spaceId = "00000000-0000-4000-8000-000000000009";
    expect(await wrapped.handler({ n: 2 }, testJobContext({ spaceId }))).toEqual({ imported: 2 });
    expect(queue).toHaveBeenCalledWith(spaceId, { runId: "00000000-0000-0000-0000-000000000000" });
    queue.mockClear();
    await wrapped.handler({ n: 0 }, testJobContext({ spaceId }));
    await wrapped.handler({ n: 3 }, testJobContext({ spaceId: null }));
    expect(queue).not.toHaveBeenCalled();
  });

  it("never fails the journal job when queueing fails", async () => {
    const log = vi.fn();
    const wrapped = withReadsCheckAfter(job, () => true, async () => {
      throw new Error("database down");
    });
    expect(await wrapped.handler({ n: 1 }, testJobContext({ spaceId: "00000000-0000-4000-8000-000000000009", log }))).toEqual({ imported: 1 });
    expect(log).toHaveBeenCalledWith("verify.reads was not queued after new journals", { message: "database down" });
  });
});
