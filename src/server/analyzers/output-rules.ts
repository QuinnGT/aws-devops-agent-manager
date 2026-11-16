import { createHash } from "node:crypto";
import type { Policy } from "@/server/policy";
import type { OutputRule } from "@/server/policy/sections/output-rules";
import type { NormBundle, NormRecord } from "./normalize";
import type { Analyzer } from "./types";

/**
 * Output rules: account masking, dashes, the DESTRUCTIVE prefix and forbidden
 * conclusions. Rules and patterns live in
 * policy/output-rules.yaml. checkOutputText() is also the check report
 * exports must pass (scope "report").
 */

export type OutputScope = "agent-output" | "report";
type OutputRulesPolicy = Policy["outputRules"];

export interface OutputViolation {
  ruleId: string;
  severity: "error" | "warning";
  description: string;
  /** Character offset in the checked text */
  index: number;
  excerpt: string;
}

function redact(match: string, mode: OutputRule["redact"]): string {
  if (mode === "hide") return "[hidden]";
  if (mode === "mask-digits") {
    const digits = match.replace(/\D/g, "").length;
    let seen = 0;
    return match.replace(/\d/g, (c) => (++seen <= digits - 4 ? "x" : c));
  }
  return match;
}

function excerptAround(text: string, start: number, end: number, chars: number, rule: OutputRule): string {
  const from = Math.max(0, start - chars);
  const to = Math.min(text.length, end + chars);
  let s = text.slice(from, to);
  // Redact every match in the excerpt, not only this one, so nearby values are not shown either.
  if (rule.redact !== "none") s = s.replace(new RegExp(rule.pattern, `${rule.flags}g`), (m) => redact(m, rule.redact));
  return `${from > 0 ? "…" : ""}${s}${to < text.length ? "…" : ""}`.replace(/\s+/g, " ").trim();
}

/** Check one text against the rules that apply to `scope`. */
export function checkOutputText(text: string, policy: OutputRulesPolicy, scope: OutputScope): OutputViolation[] {
  const out: OutputViolation[] = [];
  for (const rule of policy.rules) {
    if (!rule.appliesTo.includes(scope)) continue;
    const re = new RegExp(rule.pattern, `${rule.flags}g`);
    const allow = rule.allow.map((a) => new RegExp(`^(?:${a})$`));
    const requires = rule.kind === "require-near" && rule.requires ? new RegExp(rule.requires, rule.requiresFlags) : null;
    for (const m of text.matchAll(re)) {
      if (m[0].length === 0) continue;
      if (allow.some((a) => a.test(m[0]))) continue;
      const start = m.index;
      const end = start + m[0].length;
      if (requires) {
        const w = rule.window ?? 0;
        const around = text.slice(Math.max(0, start - w), Math.min(text.length, end + w));
        if (requires.test(around)) continue;
      }
      out.push({
        ruleId: rule.id,
        severity: rule.severity,
        description: rule.description,
        index: start,
        excerpt: excerptAround(text, start, end, policy.excerptChars, rule),
      });
    }
  }
  return out;
}

export interface OutputRulesOutput {
  incident: string;
  rulesDigest: string;
  checkedRecords: number;
  checkedChars: number;
  violations: (OutputViolation & { n: number; recordType: string })[];
  /** Violations per rule id */
  counts: Record<string, number>;
  errors: number;
  warnings: number;
}

function agentText(r: NormRecord): string {
  return r.isMessage && r.structured ? r.textBlocks.join("\n\n") : r.text;
}

function isAgentOutput(r: NormRecord, p: OutputRulesPolicy): boolean {
  if (r.isMessage) {
    if (r.role === null) return p.agentOutput.includeMessagesWithoutRole;
    return p.agentOutput.messageRoles.includes(r.role);
  }
  return p.agentOutput.recordTypes.includes(r.recordType);
}

export function rulesDigest(p: OutputRulesPolicy): string {
  return createHash("sha256").update(JSON.stringify(p)).digest("hex");
}

export function checkAgentOutput(b: NormBundle, p: OutputRulesPolicy): OutputRulesOutput {
  const violations: OutputRulesOutput["violations"] = [];
  let checkedRecords = 0;
  let checkedChars = 0;
  for (const r of b.records) {
    if (!isAgentOutput(r, p)) continue;
    const text = agentText(r);
    checkedRecords++;
    checkedChars += text.length;
    for (const v of checkOutputText(text, p, "agent-output")) violations.push({ ...v, n: r.n, recordType: r.recordType });
  }
  const counts: Record<string, number> = {};
  for (const v of violations) counts[v.ruleId] = (counts[v.ruleId] ?? 0) + 1;
  return {
    incident: b.task.incidentId ?? b.task.taskId,
    rulesDigest: rulesDigest(p),
    checkedRecords,
    checkedChars,
    violations,
    counts,
    errors: violations.filter((v) => v.severity === "error").length,
    warnings: violations.filter((v) => v.severity === "warning").length,
  };
}

export const outputRulesAnalyzer: Analyzer<OutputRulesOutput> = {
  id: "output-rules",
  version: "1.0.0",
  label: "Output rules",
  description: "Unmasked account IDs, missing DESTRUCTIVE labels and other configured patterns in agent output",
  requires: [],
  configDigest: (ctx) => rulesDigest(ctx.policy.outputRules),
  run: (b, ctx) => checkAgentOutput(b, ctx.policy.outputRules),
};
