import {
  generateText,
  isStepCount,
  jsonSchema,
  NoObjectGeneratedError,
  NoOutputGeneratedError,
  Output,
  type JSONSchema7,
  type LanguageModel,
  type ModelMessage,
  type StopCondition,
  type ToolSet,
} from "ai";
import type { CitationCheck, ModelCallRecord, ReviewRunInput, ReviewRunResult, RunReview } from "@/server/audits/contract";
import { bedrockModel } from "@/server/ai/bedrock";
import { checkCitations } from "./citations";
import { prepareReview, ReviewSetupError, type PreparedReview } from "./prompt";
import { reviewSettings, type ReviewSettings } from "./settings";
import { reviewTools } from "./tools";
import { validateOutput } from "./validate";

/**
 * The AI SDK review runner: one model review of
 * one investigation on Amazon Bedrock. `generateText` runs the tool loop with
 * structured output; the output is validated again with Ajv and its citations
 * are checked against the investigation's records. The audits module calls
 * this from a worker job and stores the result.
 *
 * Step limit: steps 1 to stepLimit - 1 may call tools. The last allowed step
 * runs without tools, with the profile's final-step message, so the model
 * writes its output from what it has read instead of ending on a tool call.
 * Earlier tool calls and results are turned into plain text for that step,
 * because Bedrock drops tool content from a request that has no tools. If the
 * model still ends without output, the review fails with the step count.
 *
 * Cancellation is checked between steps (a stop condition) and before the
 * first one. The timeout covers the whole run. Nothing here throws for a model,
 * network or schema failure: the result has state "failed" and a readable
 * error, without credentials or prompt text.
 *
 * A second runner (the Claude Agent SDK) would be another value
 * of profile.review.runner, dispatched in runReview below, returning the same
 * ReviewRunResult; prepareReview, checkCitations and validateOutput are shared.
 */

export { checkCitations } from "./citations";
export { recordText } from "./records";
export { reviewSettings } from "./settings";

export interface ReviewDeps {
  /** A language model to use instead of Bedrock (tests) */
  model?: unknown;
}

const MAX_ERROR_CHARS = 600;

/** A readable error message with anything that looks like a credential removed. */
export function safeErrorMessage(e: unknown): string {
  const name = e instanceof Error ? e.name : "Error";
  const raw = e instanceof Error ? e.message : String(e);
  const cleaned = raw
    .replace(/\b(?:AKIA|ASIA|AROA|AIDA)[A-Z0-9]{12,}\b/g, "[redacted]")
    .replace(/(secret|token|signature|credential|authorization)(["'\s:=]+)[^\s"',;]+/gi, "$1$2[redacted]")
    .replace(/[A-Za-z0-9+/=_-]{60,}/g, "[redacted]")
    .replace(/\s+/g, " ")
    .trim();
  const text = name && name !== "Error" && !cleaned.startsWith(name) ? `${name}: ${cleaned}` : cleaned;
  return text.length > MAX_ERROR_CHARS ? `${text.slice(0, MAX_ERROR_CHARS)}…` : text;
}

function isTimeout(e: unknown): boolean {
  for (let c: unknown = e, i = 0; c && i < 4; c = (c as { cause?: unknown }).cause, i++) {
    if (c instanceof Error || (typeof c === "object" && c !== null && "name" in c)) {
      if ((c as { name?: unknown }).name === "TimeoutError") return true;
    }
  }
  return false;
}

function isAbort(e: unknown): boolean {
  return !!e && typeof e === "object" && (e as { name?: unknown }).name === "AbortError";
}

/** The model asked for a tool on the tool-free last step (the SDK's ToolChoiceViolationError, not exported by name). */
function isToolChoiceViolation(e: unknown): boolean {
  return !!e && typeof e === "object" && (e as { name?: unknown }).name === "AI_ToolChoiceViolationError";
}

/** JSON from a final answer that the SDK could not parse: tolerates a markdown fence or text around one object. */
export function parseLooseJson(text: string | undefined): unknown {
  if (!text) return null;
  const candidates = [text.trim()];
  const fence = /```(?:json)?\s*([\s\S]*?)```/i.exec(text);
  if (fence?.[1]) candidates.push(fence[1].trim());
  const first = text.indexOf("{");
  const last = text.lastIndexOf("}");
  if (first >= 0 && last > first) candidates.push(text.slice(first, last + 1));
  for (const c of candidates) {
    try {
      const v: unknown = JSON.parse(c);
      if (v && typeof v === "object") return v;
    } catch {
      // try the next candidate
    }
  }
  return null;
}

function toolOutputText(output: unknown): string {
  if (!output || typeof output !== "object") return String(output ?? "");
  const o = output as { type?: string; value?: unknown };
  if (o.type === "text" || o.type === "error-text") return String(o.value ?? "");
  if (o.type === "json" || o.type === "error-json") return JSON.stringify(o.value);
  if (o.type === "execution-denied") return "(the tool call was not run)";
  if (o.type === "content" && Array.isArray(o.value)) {
    return o.value.map((p: { type?: string; text?: string }) => (p.type === "text" ? (p.text ?? "") : "")).join("\n");
  }
  return JSON.stringify(output);
}

/**
 * Messages for the final, tool-free step: assistant tool calls and tool results
 * become plain text, so the model keeps what it read (Bedrock removes tool
 * content from a request without tools).
 */
export function flattenToolMessages(messages: ModelMessage[]): ModelMessage[] {
  const out: ModelMessage[] = [];
  for (const m of messages) {
    if (m.role === "assistant" && Array.isArray(m.content)) {
      const parts: string[] = [];
      for (const p of m.content) {
        if (p.type === "text" && p.text.trim()) parts.push(p.text);
        else if (p.type === "tool-call") parts.push(`[Called ${p.toolName} ${JSON.stringify(p.input)}]`);
      }
      out.push({ role: "assistant", content: parts.length ? parts.join("\n\n") : "(tool calls)" });
    } else if (m.role === "tool") {
      const parts: string[] = [];
      for (const p of m.content) {
        if (p.type === "tool-result") parts.push(`[Result of ${p.toolName}]\n${toolOutputText(p.output)}`);
      }
      out.push({ role: "user", content: parts.join("\n\n") || "(no tool output)" });
    } else {
      out.push(m);
    }
  }
  return out;
}

interface Tally {
  /** Steps started (model calls made) */
  steps: number;
  /** Steps that finished */
  finished: number;
  inputTokens: number | null;
  outputTokens: number | null;
}

const add = (a: number | null, b: number | undefined) => (b === undefined || b === null ? a : (a ?? 0) + b);

async function isCancelled(input: ReviewRunInput): Promise<boolean> {
  try {
    return (await input.cancelled?.()) === true;
  } catch {
    return false;
  }
}

export const runReview: RunReview = async (input, deps?: ReviewDeps) => {
  const started = Date.now();
  const s = reviewSettings(input.profile);
  const tally: Tally = { steps: 0, finished: 0, inputTokens: null, outputTokens: null };
  let promptDigestValue = "";

  const result = (over: {
    state: "succeeded" | "failed";
    output?: unknown;
    schemaValid?: boolean;
    schemaErrors?: string[];
    citationCheck?: CitationCheck | null;
    error: string | null;
    called: boolean;
  }): ReviewRunResult => {
    const durationMs = Date.now() - started;
    const call: ModelCallRecord = {
      purpose: "review",
      runner: s.runner,
      modelId: s.modelId ?? "not set",
      region: input.region,
      steps: tally.steps,
      inputTokens: tally.inputTokens,
      outputTokens: tally.outputTokens,
      durationMs,
      error: over.error,
    };
    return {
      state: over.state,
      runner: s.runner,
      modelId: s.modelId ?? "not set",
      promptDigest: promptDigestValue,
      output: over.output ?? null,
      schemaValid: over.schemaValid ?? false,
      schemaErrors: over.schemaErrors ?? [],
      citationCheck: over.citationCheck ?? null,
      steps: tally.steps,
      inputTokens: tally.inputTokens,
      outputTokens: tally.outputTokens,
      durationMs,
      error: over.error,
      modelCalls: over.called ? [call] : [],
    };
  };

  if (s.runner !== "ai-sdk") return result({ state: "failed", error: `The review runner "${s.runner}" is not available.`, called: false });
  const modelId = s.modelId;
  if (!modelId && !deps?.model) return result({ state: "failed", error: "No review model is set for this audit.", called: false });

  let prepared: PreparedReview;
  try {
    prepared = prepareReview(input, s);
  } catch (e) {
    return result({ state: "failed", error: e instanceof ReviewSetupError ? e.message : `The review could not be prepared: ${safeErrorMessage(e)}`, called: false });
  }
  promptDigestValue = prepared.promptDigest;

  if (await isCancelled(input)) return result({ state: "failed", error: "The review was cancelled before it started.", called: false });

  let model: LanguageModel;
  try {
    model = (deps?.model as LanguageModel | undefined) ?? bedrockModel(input.space, input.actor, modelId!, input.region);
  } catch (e) {
    return result({ state: "failed", error: `The model could not be set up: ${safeErrorMessage(e)}`, called: false });
  }

  let cancelled = false;
  const stopWhen: StopCondition<ToolSet>[] = [
    isStepCount(s.stepLimit),
    async () => {
      if (await isCancelled(input)) cancelled = true;
      return cancelled;
    },
  ];

  let output: unknown = null;
  let error: string | null = null;
  try {
    const run = await runModel(model, input, s, prepared, stopWhen, tally);
    try {
      output = run.output;
    } catch (e) {
      if (!NoOutputGeneratedError.isInstance(e)) throw e;
      output = null;
    }
    if (output === null || output === undefined) {
      output = null;
      if (cancelled) error = `The review was cancelled after ${tally.steps} steps.`;
      else if (tally.steps >= s.stepLimit) error = `The step limit (${s.stepLimit}) was reached without output.`;
      else error = `The model stopped without output (finish reason: ${run.finishReason}).`;
    }
  } catch (e) {
    if (NoObjectGeneratedError.isInstance(e)) {
      output = parseLooseJson(e.text);
      if (output === null) error = "The model's final answer was not valid JSON.";
    } else if (isTimeout(e)) {
      error = `The review timed out after ${s.timeoutSeconds} seconds, ${tally.finished < tally.steps ? `during step ${tally.steps}` : `after ${tally.finished} steps`}.`;
    } else if (isToolChoiceViolation(e) && tally.steps >= s.stepLimit) {
      error = `The step limit (${s.stepLimit}) was reached without output: the model asked for a tool on the last step.`;
    } else if (isAbort(e) && cancelled) {
      error = `The review was cancelled after ${tally.steps} steps.`;
    } else {
      error = `The model call failed: ${safeErrorMessage(e)}`;
    }
  }

  if (output === null) return result({ state: "failed", error, called: true });

  let schemaErrors: string[];
  try {
    schemaErrors = validateOutput(prepared.schema, output);
  } catch (e) {
    schemaErrors = [`The output could not be validated: ${safeErrorMessage(e)}`];
  }
  const schemaValid = schemaErrors.length === 0;
  const citationCheck = typeof output === "object" ? checkCitations(output, input.bundle) : null;
  if (!schemaValid && !error) error = `The output does not match the schema (${schemaErrors.length} ${schemaErrors.length === 1 ? "error" : "errors"}).`;
  return result({ state: schemaValid && !error ? "succeeded" : "failed", output, schemaValid, schemaErrors, citationCheck, error, called: true });
};

async function runModel(model: LanguageModel, input: ReviewRunInput, s: ReviewSettings, prepared: PreparedReview, stopWhen: StopCondition<ToolSet>[], tally: Tally) {
  const finalStep = s.stepLimit - 1;
  const first: ModelMessage = {
    role: "user",
    content: [{ type: "text", text: prepared.prompt }],
    ...(s.promptCache ? { providerOptions: { bedrock: { cachePoint: { type: "default" } } } } : {}),
  };
  return generateText({
    model,
    instructions: prepared.system,
    messages: [first],
    tools: reviewTools(input.bundle, s.toolOutputCapChars),
    output: Output.object({
      name: "review",
      description: typeof prepared.schema.title === "string" ? prepared.schema.title : undefined,
      // Ajv validates afterwards and reports every error, so the SDK only parses the JSON.
      schema: jsonSchema(prepared.modelSchema as JSONSchema7, { validate: (value) => ({ success: true, value }) }),
    }),
    stopWhen,
    prepareStep: ({ stepNumber, messages }) => {
      if (stepNumber < finalStep) return undefined;
      return {
        toolChoice: "none",
        activeTools: [],
        messages: stepNumber > 0 ? [...flattenToolMessages(messages), { role: "user", content: prepared.finalStep }] : messages,
      };
    },
    maxOutputTokens: s.maxOutputTokens,
    timeout: { totalMs: s.timeoutSeconds * 1000 },
    ...(s.structuredOutputMode ? { providerOptions: { amazonBedrock: { structuredOutputMode: s.structuredOutputMode } } } : {}),
    onStepStart: () => {
      tally.steps += 1;
    },
    onStepFinish: (step) => {
      tally.finished += 1;
      tally.inputTokens = add(tally.inputTokens, step.usage?.inputTokens);
      tally.outputTokens = add(tally.outputTokens, step.usage?.outputTokens);
    },
  });
}
