import { createHash } from "node:crypto";
import { condensedTrace, traceToMarkdown, type CondensedTraceOutput } from "@/server/analyzers/condensed-trace";
import type { ReviewRunInput } from "@/server/audits/contract";
import { readPolicyFile } from "@/server/policy";
import { block } from "./blocks";
import type { ReviewSettings } from "./settings";
import { compileOutputSchema } from "./validate";

/**
 * The reviewer's prompts: the system prompt and output schema from policy,
 * and the per-incident brief, a policy template whose {{placeholders}} are
 * filled by plain replacement. Untrusted content (trace, ground truth,
 * analyzer output) goes inside delimited blocks (see blocks.ts).
 *
 * Placeholders:
 *   {{incident_id}} {{title}} {{record_count}} {{step_limit}} {{tool_output_cap}}
 *   {{failure_modes}} {{fix_owners}}     the profile's lists, one "- `id` label: description" line each
 *   {{cohort}} {{cohort_label}}          the item's cohort ID and label ("none" and "No cohort" without one)
 *   {{ground_truth_fields}}              values read from the ground truth, in a <ground_truth_fields> block
 *   {{ground_truth}}                     each document in a <ground_truth kind=".."> block
 *   {{condensed_trace}}                  the trace in a <condensed_trace> block, capped at traceCharsInPrompt
 *   {{analyzer:<id>}}                    that analyzer's output as JSON in an <analyzer id=".."> block
 */

export class ReviewSetupError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ReviewSetupError";
  }
}

const PLACEHOLDER = /\{\{\s*([A-Za-z0-9_.:-]+)\s*\}\}/g;

/**
 * Replace each {{key}} with resolve(key), in one pass, so text inserted for one
 * placeholder is never scanned for another. Throws for keys resolve doesn't know.
 */
export function fillTemplate(template: string, resolve: (key: string) => string | undefined): string {
  const unknown = new Set<string>();
  const out = template.replace(PLACEHOLDER, (m, key: string) => {
    const v = resolve(key);
    if (v === undefined) {
      unknown.add(key);
      return m;
    }
    return v;
  });
  if (unknown.size) {
    throw new ReviewSetupError(`The prompt template uses unknown placeholders: ${[...unknown].map((k) => `{{${k}}}`).join(", ")}.`);
  }
  return out;
}

/** Text cut to `max` characters with a visible note of what was left out. */
export function capText(s: string, max: number): string {
  if (s.length <= max) return s;
  return `${s.slice(0, max)}\n[Cut by the app: ${s.length - max} more characters are not shown.]`;
}

/** Share of the trace budget kept for the end of the trace, where the final summaries are. */
const TRACE_TAIL_SHARE = 0.3;

export interface PromptTrace {
  text: string;
  cut: boolean;
  /** Entries left out, when cut */
  omitted: { entries: number; chars: number; fromRecord: number; toRecord: number } | null;
}

/**
 * The condensed trace as markdown, within `max` characters. When it is longer,
 * whole entries are left out from the middle: the start (prompt and first
 * steps) and the end (last steps and summaries) stay, with a note in between
 * naming the records left out.
 */
export function traceForPrompt(t: CondensedTraceOutput, max: number): PromptTrace {
  const full = traceToMarkdown(t);
  if (full.length <= max) return { text: full, cut: false, omitted: null };

  const head = traceToMarkdown({ ...t, entries: [] });
  const pieces = t.entries.map((e) => `### R${e.n} ${e.label} ${e.time}\n${e.text}`);
  const sep = 2; // "\n\n" between pieces
  const noteReserve = 400;
  let budget = max - head.length - noteReserve;

  const tail: number[] = [];
  let tailBudget = Math.floor(budget * TRACE_TAIL_SHARE);
  for (let i = pieces.length - 1; i >= 0; i--) {
    const len = pieces[i]!.length + sep;
    if (len > tailBudget) break;
    tail.unshift(i);
    tailBudget -= len;
    budget -= len;
  }
  const firstTail = tail[0] ?? pieces.length;
  const front: number[] = [];
  for (let i = 0; i < firstTail; i++) {
    const len = pieces[i]!.length + sep;
    if (len > budget) break;
    front.push(i);
    budget -= len;
  }
  const lastFront = front.length ? front[front.length - 1]! : -1;
  const omittedIdx = t.entries.map((_, i) => i).filter((i) => i > lastFront && i < firstTail);
  const omittedChars = omittedIdx.reduce((s, i) => s + pieces[i]!.length, 0);
  const fromRecord = t.entries[omittedIdx[0] ?? 0]?.n ?? 0;
  const toRecord = t.entries[omittedIdx[omittedIdx.length - 1] ?? 0]?.n ?? 0;
  const note =
    `[Trace shortened by the app to fit ${max} characters: ${omittedIdx.length} entries (${omittedChars} characters) ` +
    `from R${fromRecord} to R${toRecord} are left out here. Read those records with read_records or find them with search_records.]`;
  const text = [head, ...front.map((i) => pieces[i]!), note, ...tail.map((i) => pieces[i]!)].join("\n\n");
  return { text, cut: true, omitted: { entries: omittedIdx.length, chars: omittedChars, fromRecord, toRecord } };
}

function isTrace(v: unknown): v is CondensedTraceOutput {
  return !!v && typeof v === "object" && Array.isArray((v as CondensedTraceOutput).entries) && typeof (v as CondensedTraceOutput).records === "number";
}

/** The stored condensed-trace output, or one built from the bundle when it is missing or malformed. */
export function traceOf(input: Pick<ReviewRunInput, "analyzerOutputs" | "bundle">): CondensedTraceOutput {
  const stored = input.analyzerOutputs["condensed-trace"];
  return isTrace(stored) ? stored : condensedTrace(input.bundle);
}

function listLines(items: { id: string; label: string; description: string }[]): string {
  if (!items.length) return "   - (none configured)";
  return items.map((i) => `   - \`${i.id}\` ${i.label}${i.description ? `: ${i.description}` : ""}`).join("\n");
}

function groundTruthFields(input: ReviewRunInput): string {
  const lines: string[] = [];
  for (const doc of input.groundTruth) {
    const spec = input.profile.inputs.find((i) => i.kind === doc.kind);
    for (const [id, value] of Object.entries(doc.fields)) {
      const label = spec?.fields[id]?.label ?? id;
      lines.push(`${doc.label} / ${label}: ${value ?? "not found"}`);
    }
  }
  return block("ground_truth_fields", lines.length ? lines.join("\n") : "No fields were read from the ground truth.");
}

function groundTruthDocs(input: ReviewRunInput, cap: number): string {
  if (!input.groundTruth.length) return block("ground_truth", "No ground-truth documents were provided for this incident.");
  return input.groundTruth
    .map((d) => block("ground_truth", capText(d.body, cap), { kind: d.kind, label: d.label, file: d.fileName }))
    .join("\n\n");
}

function analyzerBlock(input: ReviewRunInput, id: string, cap: number): string {
  const out = input.analyzerOutputs[id];
  if (out === undefined || out === null) return block("analyzer", "Not available for this investigation.", { id });
  let json: string;
  try {
    json = JSON.stringify(out, null, 2) ?? "null";
  } catch {
    json = "The stored output could not be shown.";
  }
  return block("analyzer", capText(json, cap), { id });
}

export function incidentIdOf(input: Pick<ReviewRunInput, "incidentId" | "bundle">): string {
  return input.incidentId ?? input.bundle.task.incidentId ?? input.bundle.task.taskId;
}

/** Resolves the brief's placeholders for one investigation. */
export function promptValues(input: ReviewRunInput, s: ReviewSettings): (key: string) => string | undefined {
  const fixed: Record<string, () => string> = {
    incident_id: () => incidentIdOf(input),
    title: () => (input.bundle.task.title ?? "(no title)").replace(/[\r\n]+/g, " "),
    record_count: () => String(input.bundle.records.length),
    step_limit: () => String(s.stepLimit),
    tool_output_cap: () => String(s.toolOutputCapChars),
    failure_modes: () => listLines(input.profile.failureModes),
    fix_owners: () => listLines(input.profile.fixOwners),
    cohort: () => input.cohort?.id ?? "none",
    cohort_label: () => (input.cohort?.label ?? "No cohort").replace(/[\r\n]+/g, " "),
    ground_truth_fields: () => groundTruthFields(input),
    ground_truth: () => groundTruthDocs(input, s.groundTruthCharsInPrompt),
    condensed_trace: () => {
      const t = traceForPrompt(traceOf(input), s.traceCharsInPrompt);
      return block("condensed_trace", t.text, { records: input.bundle.records.length, shortened: t.cut ? "yes" : "no" });
    },
  };
  return (key) => {
    if (Object.hasOwn(fixed, key)) return fixed[key]!();
    if (key.startsWith("analyzer:")) return analyzerBlock(input, key.slice("analyzer:".length), s.analyzerCharsInPrompt);
    return undefined;
  };
}

export interface PreparedReview {
  system: string;
  prompt: string;
  finalStep: string;
  /** The output schema as parsed from policy (Ajv validates against this) */
  schema: Record<string, unknown>;
  /** The schema sent to the model: without $schema and $id, which carry no constraint */
  modelSchema: Record<string, unknown>;
  promptDigest: string;
}

function readFile(dirs: string[], rel: string, what: string): string {
  let text: string | null;
  try {
    text = readPolicyFile(dirs, rel);
  } catch {
    throw new ReviewSetupError(`The ${what} path is not valid: ${rel}`);
  }
  if (text === null) throw new ReviewSetupError(`The ${what} was not found in policy: ${rel}`);
  return text;
}

/** SHA-256 over the system prompt, filled prompt and output schema text. */
export function promptDigest(system: string, prompt: string, schemaText: string): string {
  return createHash("sha256").update(system).update("\0").update(prompt).update("\0").update(schemaText).digest("hex");
}

/** Reads the prompts and schema from policy and fills the brief. Throws ReviewSetupError. */
export function prepareReview(input: ReviewRunInput, s: ReviewSettings): PreparedReview {
  const system = readFile(input.policyDirs, s.systemPrompt, "reviewer system prompt");
  const template = readFile(input.policyDirs, s.promptTemplate, "prompt template");
  const finalStep = readFile(input.policyDirs, s.finalStepPrompt, "final step prompt");
  const schemaText = readFile(input.policyDirs, s.outputSchema, "output schema");
  let schema: unknown;
  try {
    schema = JSON.parse(schemaText);
  } catch {
    throw new ReviewSetupError(`The output schema is not valid JSON: ${s.outputSchema}`);
  }
  if (!schema || typeof schema !== "object" || Array.isArray(schema) || (schema as { type?: unknown }).type !== "object") {
    throw new ReviewSetupError(`The output schema must describe a JSON object: ${s.outputSchema}`);
  }
  try {
    compileOutputSchema(schema as Record<string, unknown>);
  } catch (e) {
    throw new ReviewSetupError(`The output schema is not valid JSON Schema (${s.outputSchema}): ${e instanceof Error ? e.message : String(e)}`);
  }
  const prompt = fillTemplate(template, promptValues(input, s));
  const { $schema: _s, $id: _i, ...modelSchema } = schema as Record<string, unknown>;
  return {
    system,
    prompt,
    finalStep: finalStep.trim(),
    schema: schema as Record<string, unknown>,
    modelSchema,
    promptDigest: promptDigest(system, prompt, schemaText),
  };
}
