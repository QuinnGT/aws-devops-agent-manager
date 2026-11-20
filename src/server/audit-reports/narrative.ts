import { generateText, type LanguageModel } from "ai";
import { z } from "zod";
import { bedrockModel, inferenceRegion } from "@/server/ai/bedrock";
import { recordAuditEvent } from "@/server/audit-log";
import { db } from "@/server/db/client";
import { modelCalls } from "@/server/db/schema";
import type { JobContext } from "@/server/jobs/registry";
import { readPolicyFile } from "@/server/policy";
import type { AuditProfile } from "@/server/policy/sections/audits";
import { getSpaceById, toAwsConfig } from "@/server/spaces/queries";
import { AuditReportError } from "./errors";
import { loadReportContext } from "./loader";
import { noReportModelReason } from "./model";
import { buildTime } from "./queries";
import { sectionMarkdown } from "./report-md";
import { incidentName } from "./sections";
import { emptyDraft, patchSection, updateReportDraft } from "./store";
import type { Audience, ReportFinding, ReportSectionConfig, ReportView } from "./types";
import { acceptedFindings } from "./view";

/**
 * Narrative drafts: the model drafts only the narrative
 * sections, and a person edits them. The prompt holds the section's prompt
 * file filled with the computed tables and the accepted findings, never raw
 * journals. A shareable section only sees shareable tables, so internal
 * measurements don't reach customer text. Every call lands in model_calls
 * with purpose "report-narrative".
 */

export const RUNNER = "ai-sdk";

export const draftNarrativeInput = z.object({
  spaceId: z.string().uuid(),
  auditId: z.string().uuid(),
  /** Narrative sections to draft; every narrative section with a prompt when empty */
  sectionIds: z.array(z.string().min(1).max(200)).max(50).default([]),
  /** Also replace text a person wrote */
  replacePersonText: z.boolean().default(false),
});

export type DraftNarrativeInput = z.output<typeof draftNarrativeInput>;

export interface DraftNarrativeResult {
  modelId: string;
  drafted: string[];
  skipped: { id: string; reason: "person-text" | "no-prompt" | "cancelled" }[];
  failed: { id: string; error: string }[];
}

// ---------- prompt (pure) ----------

/** Fill {{name}} placeholders; unknown ones stay as written. */
export function fillPrompt(template: string, vars: Record<string, string>): string {
  return template.replace(/\{\{\s*(\w+)\s*\}\}/g, (m, key: string) => (Object.prototype.hasOwnProperty.call(vars, key) ? vars[key]! : m));
}

/** Shorten every string in a value to `cap` characters, and turn label IDs into readable labels. */
export function promptValue(v: unknown, cap: number, labels: Map<string, string>): unknown {
  if (typeof v === "string") {
    const s = labels.get(v) ?? v;
    return s.length > cap ? `${s.slice(0, cap)}…` : s;
  }
  if (Array.isArray(v)) return v.map((x) => promptValue(x, cap, labels));
  if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, promptValue(x, cap, labels)]));
  return v;
}

/** Finding fields that only internal sections show, per finding kind. A shareable narrative's prompt leaves them out. */
export function internalOnlyFields(profile: AuditProfile): Map<string, Set<string>> {
  const shown = (audience: Audience) => {
    const out = new Map<string, Set<string>>();
    for (const s of profile.report.sections) {
      if (s.audience !== audience || !s.findingKind) continue;
      const extractor = profile.findings.find((f) => f.kind === s.findingKind);
      const fields = s.kind === "count-table" ? (s.field ? [s.field] : []) : s.kind === "findings-table" || s.kind === "incident-list" ? (s.columns ?? extractor?.fields ?? []) : [];
      const set = out.get(s.findingKind) ?? new Set<string>();
      for (const f of fields) set.add(f.split(".")[0]!);
      out.set(s.findingKind, set);
    }
    return out;
  };
  const internal = shown("internal");
  const shareable = shown("shareable");
  const out = new Map<string, Set<string>>();
  for (const [kind, fields] of internal) out.set(kind, new Set([...fields].filter((f) => !shareable.get(kind)?.has(f))));
  return out;
}

/** Accepted findings as JSON lines, within the profile's caps. For a shareable section, fields only internal sections show are left out. */
export function findingsForPrompt(findings: ReportFinding[], profile: AuditProfile, audience: Audience = "internal"): { text: string; included: number; leftOut: number } {
  const labels = new Map<string, string>([...profile.failureModes, ...profile.fixOwners].map((x) => [x.id, x.label]));
  const { narrativeInputCapChars: cap, narrativeValueCapChars: valueCap } = profile.report;
  const drop = audience === "shareable" ? internalOnlyFields(profile) : new Map<string, Set<string>>();
  const lines: string[] = [];
  let size = 0;
  for (const f of findings) {
    const hidden = drop.get(f.kind);
    const values = hidden?.size ? Object.fromEntries(Object.entries(f.values).filter(([k]) => !hidden.has(k))) : f.values;
    const line = JSON.stringify({ incident: incidentName(f), kind: f.kind, title: promptValue(f.title, valueCap, labels), values: promptValue(values, valueCap, labels) });
    if (size + line.length + 1 > cap) break;
    lines.push(line);
    size += line.length + 1;
  }
  const leftOut = findings.length - lines.length;
  if (leftOut) lines.push(`(${leftOut} more accepted findings were left out to keep this prompt short.)`);
  return { text: lines.join("\n") || "(No accepted findings.)", included: findings.length - leftOut, leftOut };
}

/** The computed sections a narrative of `audience` may read, as markdown. */
export function tablesForPrompt(view: ReportView, audience: Audience): string {
  const parts = view.sections
    .filter((s) => s.content.type !== "narrative" && !s.hidden && (audience === "internal" || s.audience === "shareable"))
    .map((s) => sectionMarkdown(s, "shareable"));
  return parts.join("\n\n") || "(No tables.)";
}

export function buildNarrativePrompt(args: { template: string; view: ReportView; section: ReportSectionConfig; profile: AuditProfile; findings: ReportFinding[] }): string {
  const { view, section } = args;
  const reviewed = view.counts.itemsByState.reviewed ?? 0;
  return fillPrompt(args.template, {
    auditName: view.audit.name,
    reportTitle: view.title,
    profileLabel: view.audit.profileLabel,
    sectionTitle: section.title,
    audience: section.audience,
    incidentCount: String(reviewed),
    tables: tablesForPrompt(view, section.audience),
    findings: findingsForPrompt(args.findings, args.profile, section.audience).text,
  });
}

/** Model text as stored narrative: trimmed, without a wrapping markdown fence. */
export function cleanNarrative(text: string): string {
  const t = text.trim();
  const fenced = /^```(?:markdown|md)?\s*\n([\s\S]*?)\n```$/.exec(t);
  return (fenced ? fenced[1]! : t).trim();
}

function errorText(err: unknown): string {
  const s = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
  return s.slice(0, 500);
}

// ---------- job ----------

export interface NarrativeDeps {
  /** A model to use instead of Bedrock (tests pass a mock from ai/test) */
  model?: LanguageModel;
}

/** Worker handler for audit-reports.draft-narrative. */
export async function draftNarrativeHandler(input: DraftNarrativeInput, ctx: JobContext, deps: NarrativeDeps = {}): Promise<DraftNarrativeResult> {
  const space = await getSpaceById(input.spaceId);
  if (!space) throw new AuditReportError("Space not found.", "not-found");
  const started = new Date();
  const rc = await loadReportContext(space, input.auditId);
  if (!rc) throw new AuditReportError("Audit not found.", "not-found");
  // The drafts read the findings as loaded here
  const loadedAt = buildTime(started, rc.data.inputsChangedAt);
  const { audit, profile, policy, view } = rc;
  if (audit.state === "finalized") throw new AuditReportError("This audit's record is saved, so its report can't be changed.", "read-only");

  const narratives = profile.report.sections.filter((s) => s.kind === "narrative");
  const unknown = input.sectionIds.filter((id) => !narratives.some((s) => s.id === id));
  if (unknown.length) throw new AuditReportError(`The report has no narrative section ${unknown.join(", ")}.`, "invalid");
  const targets = input.sectionIds.length ? narratives.filter((s) => input.sectionIds.includes(s.id)) : narratives;

  const modelId = profile.report.modelId ?? profile.review.modelId ?? (deps.model ? "injected" : undefined);
  if (!modelId) throw new AuditReportError(noReportModelReason(profile.review.runner), "invalid");
  const region = inferenceRegion(space, space.parsedSettings);
  const model = deps.model ?? bedrockModel(toAwsConfig(space), ctx.actor, modelId, region);
  const system = profile.report.systemPrompt ? readPolicyFile(policy.dirs, profile.report.systemPrompt) : null;
  if (profile.report.systemPrompt && system === null) throw new AuditReportError(`The report system prompt ${profile.report.systemPrompt} is missing from the policy directory.`, "invalid");
  const findings = acceptedFindings(rc.data.items, rc.data.findings);

  const result: DraftNarrativeResult = { modelId, drafted: [], skipped: [], failed: [] };
  const calls: { sectionId: string; inputTokens: number | null; outputTokens: number | null; durationMs: number; ok: boolean }[] = [];
  const existing = new Map((audit.report?.sections ?? []).map((s) => [s.id, s]));

  for (const [i, section] of targets.entries()) {
    if (await ctx.cancelled()) {
      result.skipped.push({ id: section.id, reason: "cancelled" });
      continue;
    }
    if (!section.prompt) {
      result.skipped.push({ id: section.id, reason: "no-prompt" });
      continue;
    }
    if (existing.get(section.id)?.narrativeSource === "person" && !input.replacePersonText) {
      result.skipped.push({ id: section.id, reason: "person-text" });
      continue;
    }
    await ctx.progress(i / targets.length, `Drafting ${section.title}`);
    const template = readPolicyFile(policy.dirs, section.prompt);
    if (template === null) {
      result.failed.push({ id: section.id, error: `The prompt file ${section.prompt} is missing from the policy directory.` });
      continue;
    }
    const prompt = buildNarrativePrompt({ template, view, section, profile, findings });

    const callStarted = Date.now();
    let text: string | null = null;
    let error: string | null = null;
    let usage: { inputTokens: number | undefined; outputTokens: number | undefined } | null = null;
    let steps: number | null = null;
    try {
      const res = await generateText({
        model,
        ...(system ? { instructions: system } : {}),
        prompt,
        maxOutputTokens: profile.report.maxOutputTokens,
        timeout: profile.report.timeoutSeconds * 1000,
      });
      usage = res.usage;
      steps = res.steps.length;
      text = cleanNarrative(res.text);
      if (!text) error = "The model returned no text.";
      else if (text.length > profile.report.narrativeMaxChars) error = `The draft is longer than ${profile.report.narrativeMaxChars} characters.`;
    } catch (err) {
      error = errorText(err);
      ctx.log("narrative draft failed", { section: section.id, error });
    }
    const durationMs = Date.now() - callStarted;
    calls.push({ sectionId: section.id, inputTokens: usage?.inputTokens ?? null, outputTokens: usage?.outputTokens ?? null, durationMs, ok: !error });
    await db()
      .insert(modelCalls)
      .values({
        spaceId: space.id,
        auditId: audit.id,
        reviewId: null,
        purpose: "report-narrative",
        runner: RUNNER,
        modelId,
        region,
        steps,
        inputTokens: usage?.inputTokens ?? null,
        outputTokens: usage?.outputTokens ?? null,
        durationMs,
        error,
        actor: ctx.actor.email,
      });
    if (error || !text) {
      result.failed.push({ id: section.id, error: error ?? "The model returned no text." });
      continue;
    }

    // A person may have saved text while the model was writing; keep it unless asked not to.
    let kept = false;
    const narrative = text;
    await updateReportDraft(audit, ctx.actor, (d) => {
      const draft = d ?? emptyDraft(loadedAt);
      if (!input.replacePersonText && draft.sections.find((s) => s.id === section.id)?.narrativeSource === "person") {
        kept = true;
        return draft;
      }
      // The draft read the findings as they were at loadedAt; a decision after that needs a fresh check.
      return patchSection(draft, section.id, { narrative, narrativeSource: "model", draftedAt: loadedAt.toISOString(), approvedBy: null, approvedAt: null }, { email: ctx.actor.email, at: new Date() });
    });
    if (kept) result.skipped.push({ id: section.id, reason: "person-text" });
    else result.drafted.push(section.id);
  }

  if (result.drafted.length) {
    // The drafts read the findings as they were at loadedAt
    await updateReportDraft(audit, ctx.actor, (d) => {
      const draft = d ?? emptyDraft(loadedAt);
      return Date.parse(draft.builtAt) >= loadedAt.getTime() ? draft : { ...draft, builtAt: loadedAt.toISOString() };
    });
  }

  await recordAuditEvent({
    actor: ctx.actor,
    action: "audit.report.narrative-draft",
    spaceId: space.id,
    targetType: "audit",
    targetId: audit.id,
    result: result.failed.length ? "error" : "ok",
    details: { modelId, region, drafted: result.drafted, skipped: result.skipped, failed: result.failed, calls, finishedAt: new Date().toISOString() },
  });
  await ctx.progress(1, result.failed.length ? "Some sections were not drafted" : "Narrative drafted");

  if (result.failed.length) {
    const names = result.failed.map((f) => `${targets.find((s) => s.id === f.id)?.title ?? f.id} (${f.error})`).join("; ");
    throw new AuditReportError(`The model didn't draft every section: ${names}`, "invalid");
  }
  return result;
}
