import { sectionsFor } from "./view";
import type { CountTableContent, FindingsTableContent, ReportView } from "./types";

/**
 * A narrative written from one audit's own report view, with no model: the
 * demo seed's mock model answers with it, so the sample summary describes the
 * audit it sits in (its counts and its accepted fixes) and nothing else. It
 * reads only the shareable, shown sections, as a shareable narrative's prompt
 * does. Pure.
 */

const MAX_FIXES = 12;
const TITLE_CHARS = 160;

/** "A", "A and B", "A, B and C". */
function joined(xs: readonly string[]): string {
  return xs.length <= 1 ? (xs[0] ?? "") : `${xs.slice(0, -1).join(", ")} and ${xs[xs.length - 1]}`;
}

/** The first sentence of a finding title, at most TITLE_CHARS characters, cut at a word. */
export function shortTitle(title: string): string {
  const flat = title.replace(/\s+/g, " ").trim();
  const sentence = /^(.+?[.!?])(\s|$)/.exec(flat)?.[1] ?? flat;
  if (sentence.length <= TITLE_CHARS) return sentence;
  const cut = sentence.slice(0, TITLE_CHARS);
  return `${cut.slice(0, Math.max(cut.lastIndexOf(" "), 40)).replace(/[\s,;:]+$/, "")}…`;
}

/** "Chronic noise (2), Wrong component (1)": rows with a count, largest first. */
function countLine(c: CountTableContent): string | null {
  const rows = c.rows.filter((r) => r.count > 0).sort((a, b) => b.count - a.count || a.label.localeCompare(b.label));
  return rows.length ? rows.map((r) => `${r.label} (${r.count})`).join(", ") : null;
}

/** The fixes table as one bullet per accepted fix: owner (first column) and incident, then the fix's first sentence. */
function fixLines(c: FindingsTableContent): string[] {
  const grouped = c.columns.length > 1;
  const rows = [...c.rows].sort((a, b) => (grouped ? (a.cells[0] ?? "").localeCompare(b.cells[0] ?? "") : 0));
  const lines = rows.slice(0, MAX_FIXES).map((r) => `- ${grouped && r.cells[0] ? `${r.cells[0]}, ${r.incident}` : r.incident}: ${shortTitle(r.title)}`);
  if (rows.length > MAX_FIXES) lines.push(`- And ${rows.length - MAX_FIXES} more in the table below.`);
  return lines;
}

export function summaryFromView(view: Pick<ReportView, "audit" | "counts" | "sections">): string {
  const shown = sectionsFor(view, "shareable");
  const reviewed = view.counts.itemsByState.reviewed ?? 0;
  const accepted = view.counts.findings.accepted;
  const paragraphs: string[] = [
    `The audit "${view.audit.name}" reviewed ${reviewed} ${reviewed === 1 ? "investigation" : "investigations"}, and a person accepted ${accepted} ${accepted === 1 ? "finding" : "findings"}. The counts below come from the tables in this report.`,
  ];

  const counts = shown.flatMap((s) => {
    if (s.content.type !== "count-table") return [];
    const line = countLine(s.content);
    return line ? [`- ${s.title}: ${line}.`] : [];
  });
  if (counts.length) paragraphs.push(counts.join("\n"));

  for (const s of shown) {
    if (s.content.type !== "findings-table" || !s.content.rows.length) continue;
    const n = s.content.rows.length;
    paragraphs.push(`${s.title}, ${n} accepted:`, fixLines(s.content).join("\n"));
  }

  const incidents = [...new Set(shown.flatMap((s) => (s.content.type === "incident-list" ? s.content.incidents.map((b) => b.incident) : [])))];
  if (incidents.length) paragraphs.push(`Incidents in this report: ${joined(incidents)}.`);
  return paragraphs.join("\n\n");
}
