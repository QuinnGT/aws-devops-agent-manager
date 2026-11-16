import { sectionsFor } from "./view";
import type { Audience, IncidentBlock, ReportSectionView, ReportView } from "./types";

/**
 * What an export contains, shared by the HTML export, report.md and the
 * output-rules gate, so the text that is checked is the text that ships.
 */

/** Fixed words of the export layout. */
export const COPY = {
  count: "Count",
  total: "Total",
  median: "Median",
  incident: "Incident",
  noFindings: "No accepted findings.",
  noRun: "No output",
  internalBanner: "Internal: do not share outside the team.",
  generated: (date: string) => `Generated ${date}.`,
  internalSuffix: " (internal)",
} as const;

export interface ExportSections {
  sections: ReportSectionView[];
  /** Sections left out of this export besides internal and hidden ones, and why */
  omitted: { id: string; reason: "empty-narrative" }[];
}

/** The sections an export for `audience` includes: not hidden, shareable only for the shareable audience, and no empty narrative. */
export function exportSections(view: Pick<ReportView, "sections">, audience: Audience): ExportSections {
  const omitted: ExportSections["omitted"] = [];
  const sections = sectionsFor(view, audience).filter((s) => {
    if (s.content.type === "narrative" && !s.content.text) {
      omitted.push({ id: s.id, reason: "empty-narrative" });
      return false;
    }
    return true;
  });
  return { sections, omitted };
}

export function reportHeading(view: Pick<ReportView, "title" | "audit">): string {
  return `${view.title}: ${view.audit.name}`;
}

/** The incident block heading: the finding title, with the incident name in front when the title does not already contain it. */
export function incidentHeading(b: IncidentBlock): string {
  return b.title.includes(b.incident) ? b.title : `${b.incident}: ${b.title}`;
}

/** A piece of a section's text and where it is, so an output-rule match can be located. */
export interface TextPart {
  /** "Title", "Header", "Paragraph 2", "Row 12", "Total row" or "Median row" */
  location: string;
  /** The incident the text came from, for rows and blocks built from a finding */
  incident: string | null;
  text: string;
}

/** The text of one section as the export shows it (narrative as its markdown source), in located parts. */
export function sectionParts(s: ReportSectionView): TextPart[] {
  const parts: TextPart[] = [{ location: "Title", incident: null, text: s.title }];
  const row = (n: number, text: string, incident: string | null = null) => parts.push({ location: `Row ${n}`, incident, text });
  const c = s.content;
  switch (c.type) {
    case "narrative":
      (c.text ?? "")
        .split(/\n\s*\n/)
        .filter((p) => p.trim())
        .forEach((p, i) => parts.push({ location: `Paragraph ${i + 1}`, incident: null, text: p }));
      break;
    case "count-table":
      parts.push({ location: "Header", incident: null, text: `${c.header} ${COPY.count}` });
      c.rows.forEach((r, i) => row(i + 1, `${r.label} ${r.count}`));
      parts.push({ location: "Total row", incident: null, text: `${COPY.total} ${c.total}` });
      break;
    case "findings-table":
      parts.push({ location: "Header", incident: null, text: [COPY.incident, ...c.columns.map((x) => x.header)].join(" ") });
      c.rows.forEach((r, i) => row(i + 1, [r.incident, ...r.cells].join(" "), r.incident));
      break;
    case "incident-list":
      for (const b of c.incidents) {
        parts.push({ location: b.incident, incident: b.incident, text: [incidentHeading(b), ...[...b.evidence, ...b.fields].map((e) => `${e.label} ${e.value}`)].join("\n") });
      }
      break;
    case "metrics-table":
      parts.push({ location: "Header", incident: null, text: [COPY.incident, ...c.columns.map((x) => x.header)].join(" ") });
      c.rows.forEach((r, i) => row(i + 1, [r.incident, ...r.cells.map((x) => x ?? "")].join(" "), r.incident));
      if (c.rows.length > 1) parts.push({ location: "Median row", incident: null, text: [COPY.median, ...c.medians.map((m) => m ?? "")].join(" ") });
      break;
  }
  return parts;
}

/** Plain text of one section as the export shows it. */
export function sectionText(s: ReportSectionView): string {
  return sectionParts(s)
    .map((p) => p.text)
    .join("\n");
}

/** Text of the export header (title and date line). */
export function headerText(view: Pick<ReportView, "title" | "audit">, audience: Audience, date: string): string {
  return [reportHeading(view), COPY.generated(date), audience === "internal" ? COPY.internalBanner : ""].filter(Boolean).join("\n");
}

/** YYYY-MM-DD in UTC. */
export function isoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}
