import { describe, expect, it, vi } from "vitest";
import { liveErrorMessage } from "@/server/assets/live";
import { getAppPolicy } from "@/server/policy";
import { isAppError, plainErrorOf, plainErrorText } from "./error-text";
import { isWaitingForWorker, jobStatusView } from "./status";
import { jobLabel, JOB_STATUS_WORDS, WORKER_WAIT_TEXT } from "./words";

const created = new Date("2026-11-12T10:00:00Z");
const at = (seconds: number) => new Date(created.getTime() + seconds * 1000);

function run(over: Partial<Parameters<typeof jobStatusView>[0]> = {}): Parameters<typeof jobStatusView>[0] {
  return {
    id: "00000000-0000-0000-0000-000000000001",
    queue: "releases.create",
    bossJobId: "boss-1",
    status: "queued",
    progress: 0,
    message: null,
    actorEmail: "a@example.com",
    spaceId: null,
    input: {},
    result: null,
    error: null,
    createdAt: created,
    startedAt: null,
    finishedAt: null,
    ...over,
  };
}

describe("waiting for the background worker", () => {
  it("has a policy threshold of 20 seconds by default", () => {
    expect(getAppPolicy().policy.api.workerWaitSeconds).toBe(20);
  });

  it("is true only for a queued job past the threshold that pg-boss hasn't started", () => {
    const queued = { status: "queued" as const, createdAt: created };
    expect(isWaitingForWorker(queued, null, at(19), 20)).toBe(false);
    expect(isWaitingForWorker(queued, null, at(20), 20)).toBe(true);
    expect(isWaitingForWorker(queued, { state: "created", startAfter: created }, at(25), 20)).toBe(true);
    expect(isWaitingForWorker(queued, { state: "retry", startAfter: created }, at(25), 20)).toBe(true);
    // A worker has it, or pg-boss is done with it.
    expect(isWaitingForWorker(queued, { state: "active", startAfter: created }, at(25), 20)).toBe(false);
    expect(isWaitingForWorker(queued, { state: "completed", startAfter: created }, at(25), 20)).toBe(false);
    // A delayed job counts from its start time.
    expect(isWaitingForWorker(queued, { state: "created", startAfter: at(60) }, at(70), 20)).toBe(false);
    expect(isWaitingForWorker({ status: "running", createdAt: created }, null, at(600), 20)).toBe(false);
  });

  it("asks pg-boss only once the job has waited past the threshold", async () => {
    const bossInfo = vi.fn(async () => ({ state: "created" as const, startAfter: created }));
    expect((await jobStatusView(run(), { bossInfo, now: at(5), waitSeconds: 20 })).waitingForWorker).toBe(false);
    expect(bossInfo).not.toHaveBeenCalled();
    expect((await jobStatusView(run(), { bossInfo, now: at(30), waitSeconds: 20 })).waitingForWorker).toBe(true);
    expect(bossInfo).toHaveBeenCalledWith("releases.create", "boss-1");
    const active = vi.fn(async () => ({ state: "active" as const, startAfter: created }));
    expect((await jobStatusView(run(), { bossInfo: active, now: at(30), waitSeconds: 20 })).waitingForWorker).toBe(false);
  });

  it("says what to do in plain words", () => {
    expect(WORKER_WAIT_TEXT).toBe(
      "Waiting for the background worker. If this doesn't change, the worker may not be running: start it with pnpm dev:worker (local) or check the worker service.",
    );
    expect(JOB_STATUS_WORDS.queued).toBe("Waiting to start");
    expect(jobLabel("sync.space")).toBe("The sync");
    expect(jobLabel("x.unknown")).toBe("A background job");
  });
});

describe("stored errors as plain sentences", () => {
  it("keeps the message of this app's own errors and drops a bare Error prefix", () => {
    expect(plainErrorText("ReleaseError: A release named v1 already exists.")).toBe("A release named v1 already exists.");
    expect(plainErrorText("Error: boom")).toBe("boom.");
    expect(plainErrorText(null)).toBeNull();
    expect(plainErrorText("  ")).toBeNull();
    expect(isAppError("PlanServiceError: x")).toBe(true);
    expect(isAppError("CredentialsProviderError: Could not load credentials from any providers")).toBe(false);
  });

  it("sends AWS SDK errors through liveErrorMessage", () => {
    const sdk = Object.assign(new Error("Could not load credentials from any providers"), { name: "CredentialsProviderError" });
    const expected = liveErrorMessage(sdk).replace(/([^.!?)])$/, "$1.");
    expect(plainErrorText("CredentialsProviderError: Could not load credentials from any providers")).toBe(expected);
    expect(plainErrorOf(sdk)).toBe(expected);
    expect(plainErrorText("Could not load credentials from any providers")).toBe(liveErrorMessage(new Error("Could not load credentials from any providers")).replace(/([^.!?)])$/, "$1."));
  });

  it("words the job's error in the job view", async () => {
    const v = await jobStatusView(run({ status: "failed", error: "ReleaseError: The history repository is busy", finishedAt: at(3) }), { now: at(5), waitSeconds: 20 });
    expect(v).toMatchObject({ status: "failed", error: "The history repository is busy.", waitingForWorker: false });
  });
});
