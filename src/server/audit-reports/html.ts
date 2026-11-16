import { COPY, exportSections, incidentHeading, isoDate, reportHeading } from "./content";
import { escapeHtml as esc, markdownToSafeHtml } from "./markdown-html";
import type { Audience, ReportSectionView, ReportView, SectionContent } from "./types";

/**
 * The self-contained HTML export: one file, styles in a <style> element, no scripts, no external
 * URLs or fonts, every value escaped, narrative markdown sanitized on the
 * server. A Content-Security-Policy meta tag blocks any request the file
 * could still make. Pure.
 */

const CSP = "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'";

const STYLE = `
:root { color-scheme: light; }
body { margin: 0; background: #ffffff; color: #1f2328; font: 15px/1.55 system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif; }
main { max-width: 960px; margin: 0 auto; padding: 32px 24px 64px; }
h1 { font-size: 26px; line-height: 1.25; margin: 0 0 4px; }
h2 { font-size: 20px; margin: 36px 0 12px; padding-bottom: 4px; border-bottom: 1px solid #d0d7de; }
h3 { font-size: 16px; margin: 20px 0 8px; }
h4, h5, h6 { font-size: 15px; margin: 16px 0 6px; }
.meta { color: #59636e; margin: 0; }
.banner { margin: 12px 0 0; padding: 8px 12px; border: 1px solid #d4a72c; background: #fff8c5; border-radius: 6px; }
table { border-collapse: collapse; width: 100%; margin: 8px 0 16px; font-size: 14px; }
th, td { border: 1px solid #d0d7de; padding: 6px 10px; text-align: left; vertical-align: top; overflow-wrap: anywhere; }
th { background: #f6f8fa; font-weight: 600; }
.num { text-align: right; font-variant-numeric: tabular-nums; white-space: nowrap; }
tr.zero td { color: #59636e; }
tfoot td { font-weight: 600; }
.incident { border: 1px solid #d0d7de; border-radius: 6px; padding: 12px 16px; margin: 12px 0; }
.incident h3 { margin: 0 0 8px; }
dl { margin: 0; display: grid; grid-template-columns: max-content 1fr; gap: 4px 16px; }
dt { color: #59636e; }
dd { margin: 0; white-space: pre-wrap; overflow-wrap: anywhere; }
pre { background: #f6f8fa; padding: 10px; overflow: auto; border-radius: 6px; }
code { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 13px; }
blockquote { margin: 0; padding: 0 12px; border-left: 3px solid #d0d7de; color: #59636e; }
.empty { color: #59636e; font-style: italic; }
@media print { main { max-width: none; padding: 0; } h2 { break-after: avoid; } .incident { break-inside: avoid; } }
`;

function table(head: string[], rows: string[][], opts: { numeric?: (i: number) => boolean; foot?: string[]; rowClass?: (i: number) => string } = {}): string {
  const cls = (i: number) => (opts.numeric?.(i) ? ' class="num"' : "");
  const tr = (cells: string[], tag: "th" | "td", rowCls = "") => `<tr${rowCls ? ` class="${rowCls}"` : ""}>${cells.map((c, i) => `<${tag}${cls(i)}>${esc(c)}</${tag}>`).join("")}</tr>`;
  return [
    "<table>",
    `<thead>${tr(head, "th")}</thead>`,
    `<tbody>${rows.map((r, i) => tr(r, "td", opts.rowClass?.(i) ?? "")).join("")}</tbody>`,
    opts.foot ? `<tfoot>${tr(opts.foot, "td")}</tfoot>` : "",
    "</table>",
  ].join("");
}

const empty = (text: string) => `<p class="empty">${esc(text)}</p>`;

function content(c: SectionContent): string {
  switch (c.type) {
    case "narrative":
      return markdownToSafeHtml(c.text ?? "", { headingOffset: 2 });
    case "count-table":
      return table(
        [c.header, COPY.count],
        c.rows.map((r) => [r.label, String(r.count)]),
        { numeric: (i) => i === 1, foot: [COPY.total, String(c.total)], rowClass: (i) => (c.rows[i]!.count === 0 ? "zero" : "") },
      );
    case "findings-table":
      if (!c.rows.length) return empty(COPY.noFindings);
      return table(
        [COPY.incident, ...c.columns.map((x) => x.header)],
        c.rows.map((r) => [r.incident, ...r.cells]),
      );
    case "incident-list":
      if (!c.incidents.length) return empty(COPY.noFindings);
      return c.incidents
        .map((b) => {
          const items = [...b.evidence, ...b.fields].map((e) => `<dt>${esc(e.label)}</dt><dd>${esc(e.value)}</dd>`).join("");
          return `<article class="incident"><h3>${esc(incidentHeading(b))}</h3>${items ? `<dl>${items}</dl>` : ""}</article>`;
        })
        .join("\n");
    case "metrics-table":
      return table(
        [COPY.incident, ...c.columns.map((x) => x.header)],
        c.rows.map((r) => [r.incident, ...r.cells.map((x) => x ?? (r.missing ? COPY.noRun : ""))]),
        { numeric: (i) => i > 0, ...(c.rows.length > 1 ? { foot: [COPY.median, ...c.medians.map((m) => m ?? "")] } : {}) },
      );
  }
}

function section(s: ReportSectionView): string {
  return `<section>\n<h2>${esc(s.title)}</h2>\n${content(s.content)}\n</section>`;
}

export interface RenderedHtml {
  html: string;
  sections: string[];
  omitted: { id: string; reason: "empty-narrative" }[];
}

/** The export file for one audience. `generatedAt` dates the file. */
export function renderReportHtml(view: ReportView, audience: Audience, generatedAt: Date): RenderedHtml {
  const { sections, omitted } = exportSections(view, audience);
  const heading = reportHeading(view);
  const html = [
    "<!doctype html>",
    '<html lang="en">',
    "<head>",
    '<meta charset="utf-8">',
    `<meta http-equiv="Content-Security-Policy" content="${CSP}">`,
    '<meta name="referrer" content="no-referrer">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    `<title>${esc(heading)}</title>`,
    `<style>${STYLE}</style>`,
    "</head>",
    "<body>",
    "<main>",
    "<header>",
    `<h1>${esc(heading)}</h1>`,
    `<p class="meta">${esc(COPY.generated(isoDate(generatedAt)))}</p>`,
    audience === "internal" ? `<p class="banner">${esc(COPY.internalBanner)}</p>` : "",
    "</header>",
    ...sections.map(section),
    "</main>",
    "</body>",
    "</html>",
    "",
  ]
    .filter((l) => l !== "")
    .join("\n");
  return { html: `${html}\n`, sections: sections.map((s) => s.id), omitted };
}
