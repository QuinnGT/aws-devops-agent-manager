import { randomBytes, randomUUID } from "node:crypto";
import {
  CreateAssetCommand,
  CreateChatCommand,
  DeleteAssetCommand,
  SendMessageCommand,
  type DevOpsAgentClient,
  type SendMessageEvents,
} from "@aws-sdk/client-devops-agent";
import { awsErrorKind, deniedAction, errorDetail, NO_CREDENTIALS_SENTENCE } from "@/server/ai/error-kind";
import type { CitationCheck, ModelCallRecord, ReviewRunInput, ReviewRunResult } from "@/server/audits/contract";
import { devOpsAgentClient } from "@/server/aws/clients";
import { loadPolicyFromDirs, readPolicyFile } from "@/server/policy";
import { checkCitations } from "./citations";
import { REVIEW_FILE_NAMES, reviewFiles, type ReviewFiles } from "./files";
import { parseLooseJson, safeErrorMessage } from "./index";
import { fillTemplate, incidentIdOf, ReviewSetupError } from "./prompt";
import { reviewSettings, type ReviewSettings } from "./settings";
import { validateOutput } from "./validate";

/**
 * The DevOps Agent chat review runner (runner "devops-agent-chat"): one review
 * of one investigation, written by a chat in the audited Agent Space instead of
 * a Bedrock model.
 *
 * The chat cannot read an investigation's journal through its own tools, so the
 * review files are attached. brief.md and records.md go up as temporary
 * `attachment` assets, a chat is created, and one message carries the reviewer
 * system prompt, the output schema and the reply rules (policy template
 * prompts/reviewer-chat.md) with the attachment IDs and the model tier. The
 * answer is the stream's `final_response` block. The attachments are deleted
 * when the run ends, whatever its result. A chat cannot be deleted through the
 * API, so each review stays in the space's chat history.
 *
 * Exception to "every write to a space goes through a plan": these attachments
 * and the chat are temporary working files of one review, not part of the
 * space's configuration. They carry the policy's attachment prefix
 * (review.chat.attachmentPrefix), and the sync leaves attachments with that
 * prefix out of history (sync.yaml ignoredAttachmentPrefixes). The runner
 * creates and deletes only assets it created itself.
 *
 * The chat approves nothing: if the stream asks for an approval or carries an
 * interrupt, the review fails with a plain reason. Nothing here throws for a
 * service failure; the result has state "failed" and a readable error without
 * credentials. One message is sent, plus one repair message in the same chat
 * when the first reply is not JSON. The profile's timeout covers the whole run,
 * and cancellation is checked while the chat answers.
 *
 * Reviews run in the worker: the chat calls use the space's write role
 * (aidevops:CreateChat and aidevops:SendMessage, with the attachments'
 * CreateAsset and DeleteAsset), see docs/aws-setup.md.
 */

const RUNNER = "devops-agent-chat";

/** The model tier the service uses when a message names none (SendMessage API reference). */
const SERVICE_DEFAULT_TIER = "balanced";

/** Stream block types of a chat reply (measured on a live space): the answer, and the text a chat writes before it. */
const ANSWER_BLOCK = "final_response";
const TEXT_BLOCK = "text";

/** A block type, unknown event name or JSON field that means the chat is waiting for a person's decision. */
const APPROVAL_TYPE = /approv|interrupt/i;
const APPROVAL_FIELDS = /"(?:interruptId|approvalId)"/;

export interface ChatDeps {
  /** A DevOps Agent client to use instead of the space's write client (tests) */
  client?: DevOpsAgentClient;
  /** Where a note goes that is not part of the result, such as an attachment that could not be deleted */
  log?: (message: string, extra?: Record<string, unknown>) => void;
}

/** A reason to stop the review, already worded for the person who reads it. */
class ChatStop extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ChatStop";
  }
}

const mb = (bytes: number) => `${(bytes / 1_000_000).toFixed(1)} MB`;

function isCancelled(input: ReviewRunInput): Promise<boolean> {
  return Promise.resolve()
    .then(() => input.cancelled?.())
    .then((v) => v === true)
    .catch(() => false);
}

/** The audit form's tier, when it is one of the policy's values, else the policy's default; null when policy names no tier option. */
export function chatModelTier(requested: string | undefined, policyDirs: string[]): string | null {
  let option;
  try {
    option = loadPolicyFromDirs(policyDirs).policy.audits.reviewers["devops-agent-chat"]?.options.modelTier;
  } catch {
    return null;
  }
  if (!option) return null;
  return requested !== undefined && option.values.some((v) => v.id === requested) ? requested : option.default;
}

function slug(text: string): string {
  return text.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60) || "review";
}

/** File names that tell one review's attachments apart from another's: prefix, incident, a random token, file. */
export function attachmentNames(prefix: string, incident: string): { brief: string; records: string } {
  const base = `${prefix}${slug(incident)}-${randomBytes(4).toString("hex")}-`;
  return { brief: `${base}${REVIEW_FILE_NAMES.brief}`, records: `${base}${REVIEW_FILE_NAMES.records}` };
}

/** The first message of the chat, from the policy template. Throws ReviewSetupError for a policy problem. */
export function chatMessage(policyDirs: string[], s: ReviewSettings, files: ReviewFiles, names: { brief: string; records: string }): string {
  const template = readPolicyText(policyDirs, s.chat.messageTemplate, "chat message template");
  const values: Record<string, string> = {
    system_prompt: files.system.trim(),
    schema: files.schema.trim(),
    brief_file: names.brief,
    records_file: names.records,
  };
  return fillTemplate(template, (k) => (Object.hasOwn(values, k) ? values[k] : undefined)).trim();
}

function readPolicyText(dirs: string[], rel: string, what: string): string {
  let text: string | null;
  try {
    text = readPolicyFile(dirs, rel);
  } catch {
    throw new ReviewSetupError(`The ${what} path is not valid: ${rel}`);
  }
  if (text === null) throw new ReviewSetupError(`The ${what} was not found in policy: ${rel}`);
  return text;
}

/** A plain error when the message or the attachments are larger than the chat takes; null when they fit. */
export function sizeProblem(files: ReviewFiles, message: string, s: ReviewSettings): string | null {
  const c = s.chat;
  if (message.length > c.messageCharsCap) {
    return (
      `The review message is ${message.length} characters, and a DevOps Agent chat accepts at most ${c.messageCharsCap}. ` +
      `It holds the reviewer system prompt (${s.files.systemPrompt}), the output schema (${s.outputSchema}) and the chat template (${c.messageTemplate}). ` +
      `Shorten one of them.`
    );
  }
  const briefBytes = Buffer.byteLength(files.brief, "utf8");
  const recordsBytes = Buffer.byteLength(files.records, "utf8");
  if (briefBytes + recordsBytes > c.attachmentBytesCap) {
    return (
      `The review files are ${mb(briefBytes + recordsBytes)} together (${REVIEW_FILE_NAMES.records} ${mb(recordsBytes)}, ${REVIEW_FILE_NAMES.brief} ${mb(briefBytes)}), ` +
      `and the chat is set to read at most ${mb(c.attachmentBytesCap)}. ` +
      `Lower review.files.recordCharsCap (now ${s.files.recordCharsCap}) to cut long records, or review.traceCharsInPrompt (now ${s.traceCharsInPrompt}) ` +
      `and review.groundTruthCharsInPrompt (now ${s.groundTruthCharsInPrompt}) to shorten ${REVIEW_FILE_NAMES.brief}.`
    );
  }
  return null;
}

interface Reply {
  text: string;
  inputTokens: number | null;
  outputTokens: number | null;
}

/** The whole run's clock: one timeout for everything, and an abort that cuts a call or stream in flight. */
class Clock {
  readonly controller = new AbortController();
  timedOut = false;
  /** Rejects with a ChatStop when the timeout passes */
  readonly expired: Promise<never>;
  private timer: ReturnType<typeof setTimeout> | undefined;

  constructor(ms: number, onTimeout: () => string) {
    this.expired = new Promise<never>((_, reject) => {
      this.timer = setTimeout(() => {
        this.timedOut = true;
        this.controller.abort();
        reject(new ChatStop(onTimeout()));
      }, ms);
    });
    // Nobody may be racing it when it fires.
    this.expired.catch(() => {});
  }

  stop(): void {
    clearTimeout(this.timer);
  }
}

type Phase = "while attaching the files" | "while the chat was answering" | "while the chat was repairing its reply";

class Run {
  phase: Phase = "while attaching the files";
  cancelled = false;
  readonly clock: Clock;
  readonly calls: ModelCallRecord[] = [];
  private lastCancelCheck = 0;

  constructor(
    readonly input: ReviewRunInput,
    readonly s: ReviewSettings,
    readonly client: DevOpsAgentClient,
    readonly modelId: string,
  ) {
    this.clock = new Clock(s.timeoutSeconds * 1000, () => `The review timed out after ${s.timeoutSeconds} seconds ${this.phase}.`);
  }

  get abortSignal(): AbortSignal {
    return this.clock.controller.signal;
  }

  /** Stops the run when the audit was cancelled. Rechecked at most every cancelCheckSeconds unless `force`. */
  async checkCancelled(force = false): Promise<void> {
    const now = Date.now();
    if (!force && now - this.lastCancelCheck < this.s.chat.cancelCheckSeconds * 1000) return;
    this.lastCancelCheck = now;
    if (await isCancelled(this.input)) {
      this.cancelled = true;
      this.clock.controller.abort();
      throw new ChatStop(`The review was cancelled ${this.phase}.`);
    }
  }
}

/** What a failed call or stream means for the reader, without credentials. */
function failureText(e: unknown, run: Run | null): string {
  if (e instanceof ChatStop) return e.message;
  if (run?.clock.timedOut) return `The review timed out after ${run.s.timeoutSeconds} seconds ${run.phase}.`;
  if (run?.cancelled) return `The review was cancelled ${run.phase}.`;
  if (e instanceof ReviewSetupError) return e.message;
  if (e instanceof Error && e.name === "WriteAccessError") return e.message;
  switch (awsErrorKind(e)) {
    case "no-credentials":
      return NO_CREDENTIALS_SENTENCE;
    case "access-denied": {
      const action = deniedAction(e);
      return `AWS refused the request: the space's write role isn't allowed to run a DevOps Agent chat${action ? ` (${action})` : ""}. See the chat review permissions in docs/aws-setup.md. ${errorDetail(e)}`;
    }
    default:
      return `The chat call failed: ${safeErrorMessage(e)}`;
  }
}

function sumTokens(calls: ModelCallRecord[], key: "inputTokens" | "outputTokens"): number | null {
  const seen = calls.filter((c) => c[key] !== null);
  return seen.length ? seen.reduce((n, c) => n + (c[key] ?? 0), 0) : null;
}

/** Reads one reply from the event stream: the answer's text and the token usage. Throws ChatStop for a failure, an approval or a cancel. */
async function readReply(events: AsyncIterable<SendMessageEvents>, run: Run): Promise<Reply> {
  const typeOf = new Map<number, string>();
  const textOf = new Map<number, string>();
  let usage: { inputTokens?: number; outputTokens?: number } | undefined;
  let completed = false;

  const refuseApproval = (): never => {
    throw new ChatStop("The chat asked for an approval or an interrupt, and the review approves nothing. Nothing was changed. Run the review in a space where the chat needs no approval to read two files.");
  };

  const it = events[Symbol.asyncIterator]();
  try {
    for (;;) {
      const next = await Promise.race([it.next(), run.clock.expired]);
      if (next.done) break;
      const ev = next.value;
      if (ev.contentBlockStart) {
        const type = ev.contentBlockStart.type ?? "";
        typeOf.set(ev.contentBlockStart.index ?? -1, type);
        if (APPROVAL_TYPE.test(type)) refuseApproval();
      } else if (ev.contentBlockDelta) {
        const i = ev.contentBlockDelta.index ?? -1;
        const delta = ev.contentBlockDelta.delta;
        const piece = delta?.textDelta?.text ?? delta?.jsonDelta?.partialJson ?? "";
        if (delta?.jsonDelta?.partialJson && APPROVAL_FIELDS.test(piece)) refuseApproval();
        const type = typeOf.get(i);
        // Only the answer and the text before it are kept; reasoning and tool summaries can be long.
        if (type === undefined || type === ANSWER_BLOCK || type === TEXT_BLOCK) textOf.set(i, (textOf.get(i) ?? "") + piece);
      } else if (ev.contentBlockStop) {
        const i = ev.contentBlockStop.index ?? -1;
        if (!typeOf.has(i) && ev.contentBlockStop.type) typeOf.set(i, ev.contentBlockStop.type);
        // The stop event repeats the text for some blocks, and is empty for text blocks.
        if (ev.contentBlockStop.text && !textOf.get(i) && (typeOf.get(i) === ANSWER_BLOCK || typeOf.get(i) === TEXT_BLOCK)) textOf.set(i, ev.contentBlockStop.text);
      } else if (ev.responseCompleted) {
        completed = true;
        usage = ev.responseCompleted.usage;
      } else if (ev.responseFailed) {
        const f = ev.responseFailed;
        throw new ChatStop(`The chat could not answer${f.errorCode ? ` (${f.errorCode})` : ""}${f.errorMessage ? `: ${safeErrorMessage(f.errorMessage)}` : "."}`);
      } else if (ev.$unknown && APPROVAL_TYPE.test(String(ev.$unknown[0]))) {
        refuseApproval();
      }
      await run.checkCancelled();
    }
  } finally {
    // Closing a stream that is still open can wait on the service; do not wait for it.
    void Promise.resolve(it.return?.()).catch(() => {});
  }

  if (!completed) throw new ChatStop("The chat's answer stopped before it was complete.");
  const indexes = [...typeOf.keys()].sort((a, b) => a - b);
  const finals = indexes.filter((i) => typeOf.get(i) === ANSWER_BLOCK);
  const answer = (finals.length ? finals : indexes.filter((i) => typeOf.get(i) === TEXT_BLOCK)).map((i) => textOf.get(i) ?? "").join("\n");
  return { text: answer, inputTokens: usage?.inputTokens ?? null, outputTokens: usage?.outputTokens ?? null };
}

/** One SendMessage with one ModelCallRecord, whatever its outcome. */
async function sendMessage(run: Run, executionId: string, req: { content: string; assetIds?: string[]; modelTier: string | null }): Promise<Reply> {
  const started = Date.now();
  const call: ModelCallRecord = {
    purpose: "review",
    runner: RUNNER,
    modelId: run.modelId,
    region: run.input.space.region,
    steps: 1,
    inputTokens: null,
    outputTokens: null,
    durationMs: 0,
    error: null,
  };
  run.calls.push(call);
  try {
    const res = await run.client.send(
      new SendMessageCommand({
        agentSpaceId: run.input.space.agentSpaceId,
        executionId,
        content: req.content,
        ...(req.assetIds ? { assetIds: req.assetIds } : {}),
        ...(req.modelTier ? { modelTier: req.modelTier } : {}),
      }),
      { abortSignal: run.abortSignal },
    );
    if (!res.events) throw new ChatStop("The chat returned no answer stream.");
    const reply = await readReply(res.events, run);
    call.inputTokens = reply.inputTokens;
    call.outputTokens = reply.outputTokens;
    return reply;
  } catch (e) {
    call.error = failureText(e, run);
    throw e;
  } finally {
    call.durationMs = Date.now() - started;
  }
}

async function attach(run: Run, name: string, text: string): Promise<string> {
  const res = await run.client.send(
    new CreateAssetCommand({
      agentSpaceId: run.input.space.agentSpaceId,
      assetType: "attachment",
      metadata: { filename: name, extension: name.slice(name.lastIndexOf(".") + 1), size: Buffer.byteLength(text, "utf8") },
      content: { file: { path: name, body: { text } } },
      clientToken: randomUUID(),
    }),
    { abortSignal: run.abortSignal },
  );
  const id = res.asset?.assetId;
  if (!id) throw new ChatStop(`The service did not return an ID for the attached file ${name}.`);
  return id;
}

export async function runChatReview(input: ReviewRunInput, deps: ChatDeps = {}): Promise<ReviewRunResult> {
  const started = Date.now();
  const s = reviewSettings(input.profile);
  const log = deps.log ?? ((message: string, extra?: Record<string, unknown>) => console.warn(`[chat-review] ${message}`, extra ?? ""));
  const tier = chatModelTier(s.runnerOptions.modelTier, input.policyDirs);
  const modelId = `devops-agent/${tier ?? SERVICE_DEFAULT_TIER}`;

  let digest = "";
  let run: Run | null = null;
  const attached: string[] = [];
  let output: unknown = null;
  let error: string | null = null;
  let schemaErrors: string[] = [];
  let citationCheck: CitationCheck | null = null;

  const result = (): ReviewRunResult => {
    const calls = run?.calls ?? [];
    const last = calls.at(-1);
    // Like the Bedrock review, the call that led to a failed review carries its error.
    if (error && last && !last.error) last.error = error;
    const schemaValid = output !== null && schemaErrors.length === 0;
    return {
      state: schemaValid && !error ? "succeeded" : "failed",
      runner: RUNNER,
      modelId,
      promptDigest: digest,
      output,
      schemaValid,
      schemaErrors,
      citationCheck,
      steps: calls.length,
      inputTokens: sumTokens(calls, "inputTokens"),
      outputTokens: sumTokens(calls, "outputTokens"),
      durationMs: Date.now() - started,
      error,
      modelCalls: calls,
    };
  };

  try {
    const files = reviewFiles(input, s);
    digest = files.promptDigest;
    const names = attachmentNames(s.chat.attachmentPrefix, incidentIdOf(input));
    const message = chatMessage(input.policyDirs, s, files, names);
    const tooBig = sizeProblem(files, message, s);
    if (tooBig) {
      error = tooBig;
      return result();
    }
    if (await isCancelled(input)) {
      error = "The review was cancelled before it started.";
      return result();
    }

    run = new Run(input, s, deps.client ?? devOpsAgentClient(input.space, "write", input.actor), modelId);
    const agentSpaceId = input.space.agentSpaceId;

    // Attachments are created one after the other so a failure leaves nothing unknown to delete.
    attached.push(await attach(run, names.brief, files.brief));
    await run.checkCancelled(true);
    attached.push(await attach(run, names.records, files.records));
    await run.checkCancelled(true);

    const chat = await run.client.send(new CreateChatCommand({ agentSpaceId }), { abortSignal: run.abortSignal });
    if (!chat.executionId) throw new ChatStop("The service did not return an ID for the chat.");

    run.phase = "while the chat was answering";
    const first = await sendMessage(run, chat.executionId, { content: message, assetIds: attached, modelTier: tier });
    if (!first.text.trim()) {
      throw new ChatStop(
        "The chat returned an empty answer. A chat read 1.8 MB of attached files in testing and returned nothing for 2.6 MB. " +
          `This review's files are ${mb(Buffer.byteLength(files.brief, "utf8") + Buffer.byteLength(files.records, "utf8"))}: lower review.files.recordCharsCap and run it again.`,
      );
    }
    output = parseLooseJson(first.text);

    if (output === null) {
      await run.checkCancelled(true);
      run.phase = "while the chat was repairing its reply";
      const repair = await sendMessage(run, chat.executionId, { content: readPolicyText(input.policyDirs, s.chat.repairPrompt, "chat repair prompt").trim(), modelTier: tier });
      output = parseLooseJson(repair.text);
      if (output === null) throw new ChatStop("The chat's answer was not valid JSON, also after one request to repair it.");
    }

    try {
      schemaErrors = validateOutput(files.schemaObject, output);
    } catch (e) {
      schemaErrors = [`The output could not be validated: ${safeErrorMessage(e)}`];
    }
    citationCheck = typeof output === "object" ? checkCitations(output, input.bundle) : null;
    if (schemaErrors.length) error = `The output does not match the schema (${schemaErrors.length} ${schemaErrors.length === 1 ? "error" : "errors"}).`;
  } catch (e) {
    error = failureText(e, run);
  } finally {
    run?.clock.stop();
    // Unlike the review's other calls, a delete is not cut off by the timeout or a cancel: a leftover file would stay in the space.
    for (const assetId of attached) {
      try {
        await run!.client.send(new DeleteAssetCommand({ agentSpaceId: input.space.agentSpaceId, assetId }));
      } catch (e) {
        log(`Could not delete the review attachment ${assetId} in space ${input.space.alias}. Delete it by hand: its name starts with ${s.chat.attachmentPrefix}.`, { message: safeErrorMessage(e) });
      }
    }
  }
  return result();
}
