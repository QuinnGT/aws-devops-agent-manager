import { checkOutputText, type OutputViolation } from "@/server/analyzers/output-rules";
import type { Policy } from "@/server/policy";
import { exportSections, headerText, isoDate, sectionParts, type TextPart } from "./content";
import type { Audience, ReportView } from "./types";

/**
 * The output-rules gate on exports. Runs the rules for scope "report"
 * (policy/output-rules.yaml) over the text of every section the export
 * includes, one section at a time, and maps each match to its row, paragraph
 * or incident block, so a person can find it. Pure.
 */

export interface ExportViolation extends OutputViolation {
  /** Section ID, or null for the export header */
  sectionId: string | null;
  sectionTitle: string;
  /** Where in the section: "Paragraph 2", "Row 12", "INCIDENT-31808", "Title" */
  location: string;
  /** The incident the text came from, when it came from a finding or an analyzer row */
  incident: string | null;
}

export interface GateResult {
  /** Violations whose severity refuses the export (profile report.exportBlockOn) */
  blocking: ExportViolation[];
  /** The rest, reported with the export */
  warnings: ExportViolation[];
}

function locate(parts: TextPart[], index: number): TextPart {
  let offset = 0;
  for (const p of parts) {
    const end = offset + p.text.length;
    if (index < end + 1) return p;
    offset = end + 1;
  }
  return parts[parts.length - 1]!;
}

export function checkExport(view: ReportView, audience: Audience, rules: Policy["outputRules"], blockOn: readonly ("error" | "warning")[], generatedAt: Date): GateResult {
  const groups: { sectionId: string | null; sectionTitle: string; parts: TextPart[] }[] = [
    { sectionId: null, sectionTitle: "Title", parts: [{ location: "Title", incident: null, text: headerText(view, audience, isoDate(generatedAt)) }] },
    ...exportSections(view, audience).sections.map((s) => ({ sectionId: s.id, sectionTitle: s.title, parts: sectionParts(s) })),
  ];
  const all: ExportViolation[] = groups.flatMap((g) => {
    const text = g.parts.map((p) => p.text).join("\n");
    return checkOutputText(text, rules, "report").map((v) => {
      const part = locate(g.parts, v.index);
      return { ...v, sectionId: g.sectionId, sectionTitle: g.sectionTitle, location: part.location, incident: part.incident };
    });
  });
  const block = new Set(blockOn);
  return { blocking: all.filter((v) => block.has(v.severity)), warnings: all.filter((v) => !block.has(v.severity)) };
}
