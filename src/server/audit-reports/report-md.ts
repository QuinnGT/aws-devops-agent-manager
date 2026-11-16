import { COPY, exportSections, incidentHeading, isoDate, reportHeading } from "./content";
import type { Audience, ReportSectionView, ReportView, SectionContent } from "./types";

/**
 * report.md for the history repository: the same sections as the export, as
 * markdown. Values from findings and analyzers are escaped so they read as
 * text (no links, emphasis, HTML or broken tables). Narrative sections are
 * markdown already and are included as written, with their headings moved
 * below the section heading. Pure.
 */

/** Escape text so markdown shows it literally, on one line. */
export function mdText(s: string): string {
  return s
    .replace(/\s+/g, " ")
    .trim()
    .replace(/&/g, "&amp;")
    .replace(/[\\`*_[\]<>|~]/g, (c) => `\\${c}`);
}

/** Move ATX headings `by` levels down (capped at 6), outside fenced code blocks. */
export function shiftHeadings(markdown: string, by: number): string {
  let fence: string | null = null;
  return markdown
    .split("\n")
    .map((line) => {
      const f = /^\s{0,3}(`{3,}|~{3,})/.exec(line);
      if (f) {
        if (!fence) fence = f[1]![0]!;
        else if (f[1]![0] === fence) fence = null;
        return line;
      }
      if (fence) return line;
      const h = /^(\s{0,3})(#{1,6})(\s|$)/.exec(line);
      if (!h) return line;
      const level = Math.min(6, h[2]!.length + by);
      return `${h[1]}${"#".repeat(level)}${line.slice(h[1]!.length + h[2]!.length)}`;
    })
    .join("\n");
}

function table(head: string[], rows: string[][], numeric: (i: number) => boolean): string {
  const line = (cells: string[]) => `| ${cells.map((c) => mdText(c) || " ").join(" | ")} |`;
  return [line(head), `| ${head.map((_, i) => (numeric(i) ? "---:" : "---")).join(" | ")} |`, ...rows.map(line)].join("\n");
}

function content(c: SectionContent): string {
  switch (c.type) {
    case "narrative":
      return shiftHeadings((c.text ?? "").trim(), 2);
    case "count-table":
      return table([c.header, COPY.count], [...c.rows.map((r) => [r.label, String(r.count)]), [COPY.total, String(c.total)]], (i) => i === 1);
    case "findings-table":
      if (!c.rows.length) return `_${mdText(COPY.noFindings)}_`;
      return table(
        [COPY.incident, ...c.columns.map((x) => x.header)],
        c.rows.map((r) => [r.incident, ...r.cells]),
        () => false,
      );
    case "incident-list":
      if (!c.incidents.length) return `_${mdText(COPY.noFindings)}_`;
      return c.incidents
        .map((b) => [`### ${mdText(incidentHeading(b))}`, "", ...[...b.evidence, ...b.fields].map((e) => `- ${mdText(e.label)}: ${mdText(e.value)}`)].join("\n"))
        .join("\n\n");
    case "metrics-table":
      return table(
        [COPY.incident, ...c.columns.map((x) => x.header)],
        [...c.rows.map((r) => [r.incident, ...r.cells.map((x) => x ?? (r.missing ? COPY.noRun : ""))]), ...(c.rows.length > 1 ? [[COPY.median, ...c.medians.map((m) => m ?? "")]] : [])],
        (i) => i > 0,
      );
  }
}

/** One section as markdown: its heading and content. */
export function sectionMarkdown(s: ReportSectionView, audience: Audience): string {
  const suffix = audience === "internal" && s.audience === "internal" ? COPY.internalSuffix : "";
  return `## ${mdText(s.title)}${suffix}\n\n${content(s.content)}`;
}

/** report.md for `audience` ("internal" for the git record: every section that is not hidden). */
export function renderReportMarkdown(view: ReportView, audience: Audience, generatedAt: Date): string {
  const { sections } = exportSections(view, audience);
  const head = [`# ${mdText(reportHeading(view))}`, "", mdText(COPY.generated(isoDate(generatedAt)))];
  if (audience === "internal") head.push("", `> ${mdText(COPY.internalBanner)}`);
  return `${[head.join("\n"), ...sections.map((s) => sectionMarkdown(s, audience))].join("\n\n")}\n`;
}
