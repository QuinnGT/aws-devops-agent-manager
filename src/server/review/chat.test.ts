import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  CreateAssetCommand,
  CreateChatCommand,
  DeleteAssetCommand,
  DevOpsAgentClient,
  SendMessageCommand,
  type SendMessageCommandInput,
  type SendMessageEvents,
} from "@aws-sdk/client-devops-agent";
import { MockLanguageModelV4 } from "ai/test";
import { mockClient } from "aws-sdk-client-mock";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ReviewRunInput, ReviewRunResult } from "@/server/audits/contract";
import { getAppPolicy, loadPolicyFromDirs, PolicyError, readPolicyFile } from "@/server/policy";
import { isIgnoredAttachment } from "@/server/sync/changes";
import { attachmentNames, chatMessage, chatModelTier, runChatReview, sizeProblem } from "./chat";
import { reviewFiles } from "./files";
import { type ReviewDeps, runReview } from "./index";
import { REVIEW_DEFAULTS, reviewSettings } from "./settings";
import { benchmarkProfile, runInput, syntheticBundle, validBenchmarkOutput } from "./test-support";

// Masked IDs, like test/fixtures/api/test-space/
const EXECUTION_ID = "00000000-0000-4000-8000-0000000000c1";
const ASSET_IDS = ["ki-00000000-0000-4000-8000-000000000001", "ki-00000000-0000-4000-8000-000000000002"];

const bundle = syntheticBundle([
  { text: "Investigate: orders not received by fulfillment-worker" },
  { text: "Checking consumer lag for fulfillment-worker" },
  { type: "investigation_summary_md", text: "Root cause: a timing race between the batch job and the stream." },
]);

const agent = mockClient(DevOpsAgentClient);
const client = new DevOpsAgentClient({ region: "us-west-2", credentials: { accessKeyId: "test", secretAccessKey: "test" } });
const log = vi.fn();

type Ev = SendMessageEvents;

/** The events of one reply, in the order measured on a live space: reasoning first, the answer in deltas, a chat title, then the usage. */
function replyEvents(answer: string, usage: { inputTokens: number; outputTokens: number } | null = { inputTokens: 4, outputTokens: 1200 }, extra: Ev[] = []): Ev[] {
  const chunks = [answer.slice(0, 40), answer.slice(40, 90), answer.slice(90)].filter((c) => c);
  let seq = 0;
  const out: Ev[] = [{ responseCreated: { responseId: "resp_1", sequenceNumber: ++seq } }, { responseInProgress: { responseId: "resp_1", sequenceNumber: ++seq } }, { heartbeat: {} }];
  out.push({ contentBlockStart: { index: 0, type: "thinking", id: "b0", sequenceNumber: ++seq } });
  out.push({ contentBlockDelta: { index: 0, delta: { textDelta: { text: '{"not":"the answer"} I need to build the JSON review.' } }, sequenceNumber: ++seq } });
  out.push({ contentBlockStop: { index: 0, type: "thinking", text: "", last: false, sequenceNumber: ++seq } });
  out.push(...extra);
  out.push({ contentBlockStart: { index: 4, type: "final_response", id: "b4", sequenceNumber: ++seq } });
  for (const text of chunks) out.push({ contentBlockDelta: { index: 4, delta: { textDelta: { text } }, sequenceNumber: ++seq } });
  out.push({ contentBlockStop: { index: 4, type: "final_response", text: "", last: true, sequenceNumber: ++seq } });
  out.push({ contentBlockStart: { index: 5, type: "chat_title", id: "b5", sequenceNumber: ++seq } });
  out.push({ contentBlockDelta: { index: 5, delta: { textDelta: { text: "Review of INCIDENT-1" } }, sequenceNumber: ++seq } });
  out.push({ contentBlockStop: { index: 5, type: "chat_title", text: "", last: false, sequenceNumber: ++seq } });
  if (usage) out.push({ responseCompleted: { responseId: "resp_1", usage, sequenceNumber: ++seq } });
  return out;
}

async function* stream(events: Ev[], hangAfter = false): AsyncGenerator<Ev> {
  for (const e of events) yield e;
  if (hangAfter) await new Promise(() => {});
}

const answerJson = () => JSON.stringify(validBenchmarkOutput());

/** Every send the mock saw, as [command name, input]. */
function sent(): [string, Record<string, unknown>][] {
  return agent.calls().map((c) => [c.args[0].constructor.name, c.args[0].input as Record<string, unknown>]);
}
const names = () => sent().map(([n]) => n);
const sends = () => sent().filter(([n]) => n === "SendMessageCommand").map(([, i]) => i as unknown as SendMessageCommandInput);

/** The happy-path service: attachments get IDs in order, a chat is created, each message answers with the next reply. */
function serve(replies: (Ev[] | ((input: SendMessageCommandInput) => Ev[]))[]) {
  let asset = 0;
  let send = 0;
  agent.on(CreateAssetCommand).callsFake(() => ({ asset: { assetId: ASSET_IDS[asset++] ?? `ki-extra-${asset}` } }));
  agent.on(CreateChatCommand).resolves({ executionId: EXECUTION_ID, createdAt: new Date("2026-11-18T22:00:00Z") });
  agent.on(DeleteAssetCommand).resolves({});
  agent.on(SendMessageCommand).callsFake((input: SendMessageCommandInput) => {
    const r = replies[Math.min(send++, replies.length - 1)]!;
    return { events: stream(typeof r === "function" ? r(input) : r) };
  });
}

const chatProfile = (over: Parameters<typeof benchmarkProfile>[0] = {}) => benchmarkProfile({ runner: "devops-agent-chat", runnerOptions: { modelTier: "smart" }, ...over });
const input = (over: Parameters<typeof runInput>[1] = {}) => runInput(bundle, { profile: chatProfile(), ...over });
const run = (over: Parameters<typeof runInput>[1] = {}) => runChatReview(input(over), { client, log });

beforeEach(() => {
  agent.reset();
  log.mockReset();
});
afterEach(() => agent.reset());

describe("runChatReview", () => {
  it("attaches the files, asks in one message and returns a checked review", async () => {
    serve([replyEvents(answerJson())]);
    const r = await run();

    expect(r.error).toBeNull();
    expect(r.state).toBe("succeeded");
    expect(r.runner).toBe("devops-agent-chat");
    expect(r.modelId).toBe("devops-agent/smart");
    expect(r.output).toEqual(validBenchmarkOutput());
    expect(r.schemaValid).toBe(true);
    expect(r.citationCheck).toMatchObject({ ok: true, failed: 0 });
    expect(r.promptDigest).toMatch(/^[0-9a-f]{64}$/);
    expect(r.steps).toBe(1);
    expect(r.inputTokens).toBe(4);
    expect(r.outputTokens).toBe(1200);
    expect(r.modelCalls).toEqual([
      { purpose: "review", runner: "devops-agent-chat", modelId: "devops-agent/smart", region: "us-west-2", steps: 1, inputTokens: 4, outputTokens: 1200, durationMs: expect.any(Number), error: null },
    ]);

    expect(names()).toEqual(["CreateAssetCommand", "CreateAssetCommand", "CreateChatCommand", "SendMessageCommand", "DeleteAssetCommand", "DeleteAssetCommand"]);
    const creates = sent()
      .filter(([n]) => n === "CreateAssetCommand")
      .map(([, i]) => i as { agentSpaceId: string; assetType: string; clientToken: string; metadata: { filename: string; extension: string; size: number }; content: { file: { path: string; body: { text: string } } } });
    expect(creates.map((c) => c.assetType)).toEqual(["attachment", "attachment"]);
    const [brief, records] = creates;
    expect(brief!.metadata.filename).toMatch(/^dam-review-INCIDENT-1-[0-9a-f]{8}-brief\.md$/);
    expect(records!.metadata.filename).toMatch(/^dam-review-INCIDENT-1-[0-9a-f]{8}-records\.md$/);
    expect(records!.metadata.filename.replace("records", "brief")).toBe(brief!.metadata.filename);
    expect(records!.content.file.path).toBe(records!.metadata.filename);
    expect(records!.metadata).toMatchObject({ extension: "md", size: Buffer.byteLength(records!.content.file.body.text, "utf8") });
    expect(records!.content.file.body.text).toContain("## R3 INVESTIGATION_SUMMARY_MD ");
    expect(brief!.content.file.body.text).toContain("records.md");
    expect(new Set(creates.map((c) => c.clientToken)).size).toBe(2);
    expect(creates.every((c) => c.agentSpaceId === "space-1")).toBe(true);

    const [message] = sends();
    expect(message).toMatchObject({ agentSpaceId: "space-1", executionId: EXECUTION_ID, modelTier: "smart", assetIds: ASSET_IDS });
    expect(message!.content!.length).toBeLessThanOrEqual(32_768);
    expect(message!.content).toContain("read-only review task");
    expect(message!.content).toContain("Do not create, update or delete any memories");
    expect(message!.content).toContain("Do not start background research tasks");
    expect(message!.content).toContain("one JSON object");
    expect(message!.content).toContain(brief!.metadata.filename);
    expect(message!.content).toContain(records!.metadata.filename);
    expect(message!.content).toContain('"additionalProperties"');
    expect(message!.content).not.toContain("{{");

    const deletes = sent().filter(([n]) => n === "DeleteAssetCommand");
    expect(deletes.map(([, i]) => (i as { assetId: string }).assetId)).toEqual(ASSET_IDS);
    expect(log).not.toHaveBeenCalled();
  });

  it.each([
    ["the audit's tier", { modelTier: "fast" }, "fast"],
    ["the policy default for a tier that is not offered", { modelTier: "turbo" }, "smart"],
    ["the policy default when the audit sets none", {}, "smart"],
  ])("uses %s", async (_label, runnerOptions, tier) => {
    serve([replyEvents(answerJson())]);
    const r = await run({ profile: chatProfile({ runnerOptions }) });
    expect(r.state).toBe("succeeded");
    expect(r.modelId).toBe(`devops-agent/${tier}`);
    expect(sends()[0]).toMatchObject({ modelTier: tier });
    expect(r.modelCalls[0]!.modelId).toBe(`devops-agent/${tier}`);
  });

  it("sends no tier, and reports the service default, when policy offers no tier option", () => {
    expect(chatModelTier("fast", [])).toBeNull();
    expect(chatModelTier("fast", getAppPolicy().dirs)).toBe("fast");
    expect(chatModelTier(undefined, getAppPolicy().dirs)).toBe("smart");
  });

  it("asks once more in the same chat when the first reply is not JSON, then validates the repaired reply", async () => {
    serve([replyEvents("I looked at the records and the agent blamed the wrong consumer.", { inputTokens: 4, outputTokens: 300 }), replyEvents(`Here it is:\n\`\`\`json\n${answerJson()}\n\`\`\``, { inputTokens: 6, outputTokens: 900 })]);
    const r = await run();

    expect(r.error).toBeNull();
    expect(r.state).toBe("succeeded");
    expect(r.steps).toBe(2);
    expect(r.inputTokens).toBe(10);
    expect(r.outputTokens).toBe(1200);
    expect(r.modelCalls.map((c) => [c.steps, c.inputTokens, c.outputTokens, c.error])).toEqual([
      [1, 4, 300, null],
      [1, 6, 900, null],
    ]);
    const [first, repair] = sends();
    expect(repair!.executionId).toBe(first!.executionId);
    expect(repair!.assetIds).toBeUndefined();
    expect(repair!.modelTier).toBe("smart");
    expect(repair!.content).toContain("could not be read as one JSON object");
    expect(names().filter((n) => n === "CreateChatCommand")).toHaveLength(1);
    expect(names().filter((n) => n === "DeleteAssetCommand")).toHaveLength(2);
  });

  it("fails when the reply is still not JSON after the repair message, and sends no third message", async () => {
    serve([replyEvents("No JSON here."), replyEvents("Still prose.")]);
    const r = await run();
    expect(r).toMatchObject({ state: "failed", output: null, steps: 2, error: "The chat's answer was not valid JSON, also after one request to repair it." });
    expect(sends()).toHaveLength(2);
    expect(r.modelCalls[1]!.error).toBe(r.error);
    expect(names().filter((n) => n === "DeleteAssetCommand")).toHaveLength(2);
  });

  it("returns output that fails the schema with every error listed", async () => {
    const bad = { ...validBenchmarkOutput(), primary_failure_mode: "Z_unknown" } as Record<string, unknown>;
    delete bad.one_line;
    serve([replyEvents(JSON.stringify(bad))]);
    const r = await run();
    expect(r.state).toBe("failed");
    expect(r.schemaValid).toBe(false);
    expect(r.output).toEqual(bad);
    expect(r.schemaErrors).toEqual(expect.arrayContaining(["one_line is required", expect.stringMatching(/^primary_failure_mode must be one of: /)]));
    expect(r.error).toBe(`The output does not match the schema (${r.schemaErrors.length} errors).`);
    expect(r.citationCheck).not.toBeNull();
    expect(r.modelCalls).toHaveLength(1);
  });

  it("flags a quote that is not in the cited record", async () => {
    const wrong = { ...validBenchmarkOutput(), citations: [{ record: 2, quote: "timing race", supports: "agent_final_answer" }] };
    serve([replyEvents(JSON.stringify(wrong))]);
    const r = await run();
    expect(r.schemaValid).toBe(true);
    expect(r.citationCheck).toMatchObject({ ok: false });
  });

  it("fails with the service's code when the stream reports responseFailed, and still deletes the attachments", async () => {
    serve([[...replyEvents("{}", null).slice(0, 4), { responseFailed: { responseId: "resp_1", errorCode: "INTERNAL_ERROR", errorMessage: "The agent hit an internal error.", sequenceNumber: 9 } }]]);
    const r = await run();
    expect(r).toMatchObject({ state: "failed", output: null, steps: 1, inputTokens: null, error: "The chat could not answer (INTERNAL_ERROR): The agent hit an internal error." });
    expect(r.modelCalls[0]!.error).toBe(r.error);
    expect(names().filter((n) => n === "DeleteAssetCommand")).toHaveLength(2);
  });

  it("fails when the stream ends before the response completed", async () => {
    serve([replyEvents(answerJson(), null)]);
    const r = await run();
    expect(r).toMatchObject({ state: "failed", output: null, error: "The chat's answer stopped before it was complete." });
  });

  it("fails with a pointer to the size setting when the chat answers with nothing", async () => {
    serve([replyEvents("")]);
    const r = await run();
    expect(r.state).toBe("failed");
    expect(r.error).toContain("The chat returned an empty answer.");
    expect(r.error).toContain("review.files.recordCharsCap");
  });

  describe("limits checked before any call", () => {
    it("fails when the files are larger than the attachment cap, naming the settings to lower", async () => {
      serve([replyEvents(answerJson())]);
      const r = await run({ profile: chatProfile({ chat: { attachmentBytesCap: 500 } }) });
      expect(r.state).toBe("failed");
      expect(r.error).toMatch(/^The review files are \d+\.\d MB together \(records\.md \d+\.\d MB, brief\.md \d+\.\d MB\), and the chat is set to read at most 0\.0 MB\./);
      expect(r.error).toContain("review.files.recordCharsCap (now 20000)");
      expect(r.error).toContain("review.traceCharsInPrompt");
      expect(r.modelCalls).toEqual([]);
      expect(r.promptDigest).toMatch(/^[0-9a-f]{64}$/);
      expect(agent.calls()).toHaveLength(0);
    });

    it("fails when the message is longer than the chat accepts, naming the files that make it up", async () => {
      serve([replyEvents(answerJson())]);
      const r = await run({ profile: chatProfile({ chat: { messageCharsCap: 1000 } }) });
      expect(r.state).toBe("failed");
      expect(r.error).toMatch(/^The review message is \d+ characters, and a DevOps Agent chat accepts at most 1000\./);
      expect(r.error).toContain("prompts/reviewer-system-files.md");
      expect(agent.calls()).toHaveLength(0);
    });

    it("measures attachments in bytes, not characters", () => {
      const s = reviewSettings(chatProfile());
      const files = { ...reviewFiles(input(), s), brief: "é".repeat(10), records: "é".repeat(10) };
      expect(sizeProblem(files, "m", { ...s, chat: { ...s.chat, attachmentBytesCap: 40 } })).toBeNull();
      expect(sizeProblem(files, "m", { ...s, chat: { ...s.chat, attachmentBytesCap: 39 } })).not.toBeNull();
    });

    it("fails plainly when a policy file is missing", async () => {
      const r = await run({ profile: chatProfile({ chat: { messageTemplate: "prompts/not-there.md" } }) });
      expect(r).toMatchObject({ state: "failed", error: "The chat message template was not found in policy: prompts/not-there.md" });
      expect(agent.calls()).toHaveLength(0);
    });
  });

  describe("attachments are deleted", () => {
    const deleted = () => sent().filter(([n]) => n === "DeleteAssetCommand").map(([, i]) => (i as { assetId: string }).assetId);

    it("when the message fails", async () => {
      serve([replyEvents(answerJson())]);
      agent.on(SendMessageCommand).rejects(Object.assign(new Error("Rate exceeded"), { name: "ThrottlingException" }));
      const r = await run();
      expect(r.state).toBe("failed");
      expect(r.error).toBe("The chat call failed: ThrottlingException: Rate exceeded");
      expect(deleted()).toEqual(ASSET_IDS);
    });

    it("when the chat cannot be created", async () => {
      serve([replyEvents(answerJson())]);
      agent.on(CreateChatCommand).rejects(new Error("boom"));
      const r = await run();
      expect(r.state).toBe("failed");
      expect(r.steps).toBe(0);
      expect(r.modelCalls).toEqual([]);
      expect(deleted()).toEqual(ASSET_IDS);
    });

    it("when only the first attachment was created", async () => {
      serve([replyEvents(answerJson())]);
      let n = 0;
      agent.on(CreateAssetCommand).callsFake(() => {
        if (n++ === 1) throw new Error("The attachment is too large.");
        return { asset: { assetId: ASSET_IDS[0] } };
      });
      const r = await run();
      expect(r.state).toBe("failed");
      expect(r.error).toContain("The attachment is too large.");
      expect(names()).toEqual(["CreateAssetCommand", "CreateAssetCommand", "DeleteAssetCommand"]);
      expect(deleted()).toEqual([ASSET_IDS[0]]);
    });

    it("logs and still returns the review when a delete fails", async () => {
      serve([replyEvents(answerJson())]);
      agent.on(DeleteAssetCommand).rejects(new Error("The asset could not be deleted."));
      const r = await run();
      expect(r.state).toBe("succeeded");
      expect(deleted()).toEqual(ASSET_IDS);
      expect(log).toHaveBeenCalledTimes(2);
      expect(log.mock.calls[0]![0]).toContain(`Could not delete the review attachment ${ASSET_IDS[0]}`);
      expect(log.mock.calls[0]![0]).toContain("dam-review-");
    });
  });

  describe("cancellation and timeout", () => {
    it("does not call AWS when the audit is cancelled before the review starts", async () => {
      serve([replyEvents(answerJson())]);
      const r = await run({ cancelled: async () => true });
      expect(r).toMatchObject({ state: "failed", steps: 0, modelCalls: [], error: "The review was cancelled before it started." });
      expect(agent.calls()).toHaveLength(0);
    });

    it("stops reading the reply and deletes the attachments when the audit is cancelled while the chat answers", async () => {
      let asking = false;
      serve([replyEvents(answerJson())]);
      agent.on(SendMessageCommand).callsFake(() => {
        asking = true;
        return { events: stream(replyEvents(answerJson())) };
      });
      const r = await run({ profile: chatProfile({ chat: { cancelCheckSeconds: 0 } }), cancelled: async () => asking });
      expect(r).toMatchObject({ state: "failed", output: null, error: "The review was cancelled while the chat was answering." });
      expect(r.modelCalls[0]!.error).toBe(r.error);
      expect(names().filter((n) => n === "DeleteAssetCommand")).toHaveLength(2);
    });

    it("checks for a cancel at most every cancelCheckSeconds", async () => {
      serve([replyEvents(answerJson())]);
      const cancelled = vi.fn(async () => false);
      await run({ cancelled });
      // Once before the start and once after each attachment (always); the events of the reply, which all arrive within the 2 second default, add none.
      expect(cancelled).toHaveBeenCalledTimes(3);
    });

    it("fails when the review runs past the profile's timeout, and deletes the attachments", async () => {
      serve([replyEvents(answerJson())]);
      agent.on(SendMessageCommand).callsFake(() => ({ events: stream(replyEvents(answerJson()).slice(0, 6), true) }));
      const r = await run({ profile: chatProfile({ timeoutSeconds: 1 }) });
      expect(r).toMatchObject({ state: "failed", output: null, error: "The review timed out after 1 seconds while the chat was answering." });
      expect(r.durationMs).toBeGreaterThanOrEqual(900);
      expect(names().filter((n) => n === "DeleteAssetCommand")).toHaveLength(2);
    });
  });

  describe("approvals", () => {
    const refused = "The chat asked for an approval or an interrupt, and the review approves nothing.";

    it("fails the review when the stream opens an approval block", async () => {
      serve([replyEvents(answerJson(), { inputTokens: 1, outputTokens: 1 }, [{ contentBlockStart: { index: 2, type: "approval_request", id: "b2", sequenceNumber: 20 } }])]);
      const r = await run();
      expect(r.state).toBe("failed");
      expect(r.output).toBeNull();
      expect(r.error).toContain(refused);
      expect(sends()).toHaveLength(1);
      expect(names().filter((n) => n === "DeleteAssetCommand")).toHaveLength(2);
    });

    it("fails the review when a tool block carries an interrupt ID", async () => {
      serve([
        replyEvents(answerJson(), { inputTokens: 1, outputTokens: 1 }, [
          { contentBlockStart: { index: 2, type: "tool_summary", id: "b2", sequenceNumber: 20 } },
          { contentBlockDelta: { index: 2, delta: { jsonDelta: { partialJson: '{"toolUseId":"t1","interruptId":"00000000-0000-4000-8000-0000000000d1"}' } }, sequenceNumber: 21 } },
        ]),
      ]);
      const r = await run();
      expect(r.state).toBe("failed");
      expect(r.error).toContain(refused);
    });

    it("fails the review on an event the SDK does not know that names an approval", async () => {
      serve([replyEvents(answerJson(), { inputTokens: 1, outputTokens: 1 }, [{ $unknown: ["approvalRequested", { approvalId: "x" }] }])]);
      const r = await run();
      expect(r.state).toBe("failed");
      expect(r.error).toContain(refused);
    });
  });

  describe("service failures", () => {
    it("says the write role is refused, with the IAM action, and does not throw", async () => {
      serve([replyEvents(answerJson())]);
      agent.on(CreateChatCommand).rejects(Object.assign(new Error("User: arn:aws:sts::111122223333:assumed-role/DevOpsAgentManagerWrite/x is not authorized to perform: aidevops:CreateChat"), { name: "AccessDeniedException" }));
      const r = await run();
      expect(r.state).toBe("failed");
      expect(r.error).toMatch(/^AWS refused the request: the space's write role isn't allowed to run a DevOps Agent chat \(aidevops:CreateChat\)\. See the chat review permissions in docs\/aws-setup\.md\./);
      expect(names().filter((n) => n === "DeleteAssetCommand")).toHaveLength(2);
    });

    it("leaves credentials out of the error", async () => {
      serve([replyEvents(answerJson())]);
      agent.on(SendMessageCommand).rejects(new Error("The security token ASIAIOSFODNN7EXAMPLE is invalid; token=abc123secretvalue"));
      const r = await run();
      expect(r.state).toBe("failed");
      expect(r.error).not.toContain("ASIAIOSFODNN7EXAMPLE");
      expect(r.error).not.toContain("abc123secretvalue");
    });

    it("fails with a plain reason, before any call, when write access is not available to this process", async () => {
      const r = await runChatReview(input(), { log });
      expect(r).toMatchObject({ state: "failed", error: "Write access to an Agent Space is allowed only inside worker jobs." });
      expect(agent.calls()).toHaveLength(0);
    });
  });
});

/** runReview with the test-only client the contract's type does not list. */
const runReviewWith: (input: ReviewRunInput, deps?: ReviewDeps) => Promise<ReviewRunResult> = runReview;

describe("runReview dispatch", () => {
  it("sends a devops-agent-chat profile to the chat runner", async () => {
    serve([replyEvents(answerJson())]);
    const r = await runReviewWith(input(), { client });
    expect(r).toMatchObject({ state: "succeeded", runner: "devops-agent-chat" });
    expect(names()).toContain("SendMessageCommand");
  });

  it("keeps an ai-sdk profile on the Bedrock runner, without a call to the space", async () => {
    const model = new MockLanguageModelV4({
      doGenerate: async () => ({
        content: [{ type: "text" as const, text: answerJson() }],
        finishReason: { unified: "stop" as const, raw: undefined },
        usage: { inputTokens: { total: 10, noCache: 10, cacheRead: undefined, cacheWrite: undefined }, outputTokens: { total: 5, text: 5, reasoning: undefined } },
        warnings: [],
      }),
    });
    const r = await runReviewWith(runInput(bundle), { model, client });
    expect(r).toMatchObject({ state: "succeeded", runner: "ai-sdk" });
    expect(model.doGenerateCalls).toHaveLength(1);
    expect(agent.calls()).toHaveLength(0);
  });
});

describe("review file names", () => {
  it("name the incident, differ per review and start with the policy prefix", () => {
    const a = attachmentNames("dam-review-", "INCIDENT-20101");
    const b = attachmentNames("dam-review-", "INCIDENT-20101");
    expect(a.records).toMatch(/^dam-review-INCIDENT-20101-[0-9a-f]{8}-records\.md$/);
    expect(a.brief).not.toBe(b.brief);
    expect(attachmentNames("x-", "a b/../c").brief).toMatch(/^x-a-b-..-c-[0-9a-f]{8}-brief\.md$/);
    expect(attachmentNames("x-", "").records).toMatch(/^x-review-[0-9a-f]{8}-records\.md$/);
  });

  it("are left out of sync by the shipped policy", () => {
    const s = reviewSettings(chatProfile());
    const { brief, records } = attachmentNames(s.chat.attachmentPrefix, "INCIDENT-1");
    const prefixes = getAppPolicy().policy.sync.ignoredAttachmentPrefixes;
    expect(isIgnoredAttachment({ assetType: "attachment", metadata: { filename: records } }, prefixes)).toBe(true);
    expect(isIgnoredAttachment({ assetType: "attachment", metadata: { filename: brief } }, prefixes)).toBe(true);
  });
});

describe("chatMessage", () => {
  it("fills the template with the system prompt, the schema and the attachment names", () => {
    const s = reviewSettings(chatProfile());
    const files = reviewFiles(input(), s);
    const m = chatMessage(getAppPolicy().dirs, s, files, { brief: "b-brief.md", records: "b-records.md" });
    expect(m).toContain(files.system.trim().slice(0, 80));
    expect(m).toContain(files.schema.trim().slice(0, 80));
    expect(m).toContain("`brief.md` is the attached file b-brief.md");
    expect(m).toContain("`records.md` is the attached file b-records.md");
    expect(m).not.toMatch(/\{\{/);
  });
});

describe("chat policy", () => {
  it("ships the default message template and repair prompt", () => {
    const dirs = getAppPolicy().dirs;
    expect(readPolicyFile(dirs, REVIEW_DEFAULTS.chat.messageTemplate)).toContain("{{system_prompt}}");
    expect(readPolicyFile(dirs, REVIEW_DEFAULTS.chat.repairPrompt)).toContain("JSON");
  });

  it("uses the defaults when a profile has no chat block, and the profile's values when it has one", () => {
    expect(reviewSettings(benchmarkProfile()).chat).toEqual(REVIEW_DEFAULTS.chat);
    const s = reviewSettings(benchmarkProfile({ chat: { messageCharsCap: 5000, attachmentPrefix: "x-" } }));
    expect(s.chat).toEqual({ ...REVIEW_DEFAULTS.chat, messageCharsCap: 5000, attachmentPrefix: "x-" });
  });

  it("rejects an attachment prefix that is not a safe file name start", () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "dam-chat-policy-"));
    try {
      mkdirSync(dir, { recursive: true });
      const overlay = (prefix: string) => writeFileSync(path.join(dir, "audits.yaml"), `profiles:\n  benchmark:\n    review:\n      chat:\n        attachmentPrefix: "${prefix}"\n`);
      overlay("review-");
      expect(loadPolicyFromDirs([...getAppPolicy().dirs, dir]).policy.audits.profiles.benchmark!.review.chat?.attachmentPrefix).toBe("review-");
      overlay("../etc/");
      expect(() => loadPolicyFromDirs([...getAppPolicy().dirs, dir])).toThrow(PolicyError);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
