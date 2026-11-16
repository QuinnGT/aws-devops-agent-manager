import { describe, expect, it, vi } from "vitest";
import { testJobContext } from "@/server/jobs/registry";
import type { SyncResult } from "@/server/sync/engine";
import { ReleaseError } from "./errors";
import { SYNC_PROGRESS, syncBeforeRelease, type SyncSpaceFn } from "./sync-first";

vi.mock("@/server/sync/engine", () => ({ syncSpace: vi.fn(async () => Promise.reject(new Error("the real sync must not run in unit tests"))) }));

const SPACE = "6f1c2a51-8d1e-4c55-9a43-0d7c1d1e2a10";
const on = { syncBeforeCreate: true };

function result(over: Partial<SyncResult> = {}): SyncResult {
  return { spaceId: SPACE, mode: "incremental", status: "succeeded", listed: 3, changedAssets: 1, changes: 1, commits: 1, deferred: 0, deleted: 0, attributionFailed: false, pushed: false, ...over };
}

describe("syncBeforeRelease", () => {
  it("syncs the space before a release of HEAD, with the sync job's deps and scaled progress", async () => {
    const sync = vi.fn<SyncSpaceFn>(async (_id, deps) => {
      await deps.progress?.(0.5, "Reading versions");
      return result();
    });
    const ctx = testJobContext({ actor: { email: "alex@example.com" }, spaceId: SPACE });
    const out = await syncBeforeRelease({ spaceId: SPACE, commit: null }, ctx, on, sync);

    expect(out).toEqual({ synced: true, result: result() });
    expect(sync).toHaveBeenCalledTimes(1);
    const [spaceId, deps, opts] = sync.mock.calls[0]!;
    expect(spaceId).toBe(SPACE);
    expect(deps.actor).toEqual({ email: "alex@example.com" });
    expect(deps.log).toBe(ctx.log);
    expect(deps.cancelled).toBe(ctx.cancelled);
    // A full listing, so assets deleted from the space aren't pinned as live.
    expect(opts).toEqual({ mode: "reconcile" });
    expect(ctx.progressCalls).toEqual([
      [SYNC_PROGRESS.from, "Syncing the space"],
      [SYNC_PROGRESS.from + 0.5 * (SYNC_PROGRESS.to - SYNC_PROGRESS.from), "Syncing: Reading versions"],
    ]);
  });

  it("skips the sync when a commit is given (tag after apply)", async () => {
    const sync = vi.fn<SyncSpaceFn>(async () => result());
    const out = await syncBeforeRelease({ spaceId: SPACE, commit: "a".repeat(40) }, testJobContext(), on, sync);
    expect(out).toEqual({ synced: false, reason: "commit-given" });
    expect(sync).not.toHaveBeenCalled();
  });

  it("skips the sync when policy turns it off", async () => {
    const sync = vi.fn<SyncSpaceFn>(async () => result());
    const out = await syncBeforeRelease({ spaceId: SPACE, commit: null }, testJobContext(), { syncBeforeCreate: false }, sync);
    expect(out).toEqual({ synced: false, reason: "policy-off" });
    expect(sync).not.toHaveBeenCalled();
  });

  it("fails with a plain message when the sync fails", async () => {
    const sync = vi.fn<SyncSpaceFn>(async () => {
      throw new Error("AccessDeniedException: not authorized to call ListAssets");
    });
    const p = syncBeforeRelease({ spaceId: SPACE, commit: null }, testJobContext(), on, sync);
    await expect(p).rejects.toBeInstanceOf(ReleaseError);
    await expect(p).rejects.toThrow("The release wasn't created because the sync of the space failed: AWS refused the request");
  });

  it("fails when another sync holds the space lock", async () => {
    const sync = vi.fn<SyncSpaceFn>(async () => result({ status: "skipped", message: "Another sync of this space is still running." }));
    await expect(syncBeforeRelease({ spaceId: SPACE, commit: null }, testJobContext(), on, sync)).rejects.toThrow(
      "The release wasn't created because another sync of this space is still running. Try again when it finishes.",
    );
  });

  it("fails when the sync was cancelled", async () => {
    const sync = vi.fn<SyncSpaceFn>(async () => result({ status: "cancelled" }));
    await expect(syncBeforeRelease({ spaceId: SPACE, commit: null }, testJobContext(), on, sync)).rejects.toThrow("The release wasn't created because the sync was cancelled.");
  });
});
