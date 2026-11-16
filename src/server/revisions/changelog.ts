import { fillTemplate } from "@/server/history/layout";
import type { RevisionsPolicy } from "@/server/policy/sections/revisions";

/**
 * The change record of a revision, generated from its change rows and the
 * findings they link, in the shape of the hand-written reference/CHANGELOG.md
 * (a "## <version>, <date>" section with a source line and a table). Pure.
 *
 * The section sits between begin and end markers that name the revision, at
 * the top of the change record above the hand-written history, so a save
 * replaces only this revision's section. Finding text is untrusted model
 * output that a person accepted: it is flattened to one line per cell, with
 * table pipes and angle brackets escaped, so it can't break the table or
 * carry HTML.
 */

type ChangelogPolicy = RevisionsPolicy["changelog"];

export interface ChangelogChange {
  message: string;
  /** Package paths the person changed */
  changedPaths: readonly string[];
  findingIds: readonly string[];
  unlinkedReason: string | null;
  createdAt: Date | string;
}

export interface ChangelogCitation {
  record: number;
  quote: string | null;
  /** The citation check found the record and the quote */
  ok: boolean;
}

export interface ChangelogFinding {
  id: string;
  auditName: string;
  incidentId: string | null;
  title: string;
  citations: readonly ChangelogCitation[];
}

export interface ChangelogInput {
  /** Revision name */
  name: string;
  /** "the live space" or "release v2.3" */
  baseLabel: string;
  /** Changes, oldest first */
  changes: readonly ChangelogChange[];
  findings: ReadonlyMap<string, ChangelogFinding>;
  /** Date of the section; default: the newest change, else now */
  date?: Date;
}

const DATE = new Intl.DateTimeFormat("en-US", { month: "long", day: "numeric", year: "numeric", timeZone: "UTC" });

/** "October 15, 2026", as the hand-written change record writes dates. */
export function changelogDate(d: Date): string {
  return DATE.format(d);
}

/** One table cell: one line, pipes and angle brackets escaped. */
export function cell(text: string): string {
  return text
    .replace(/\s+/g, " ")
    .trim()
    .replace(/\\/g, "\\\\")
    .replace(/\|/g, "\\|")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function code(path: string): string {
  return `\`${path.replace(/`/g, "")}\``;
}

function clip(s: string, max: number): string {
  const one = s.replace(/\s+/g, " ").trim();
  return one.length > max ? `${one.slice(0, max - 1).trimEnd()}…` : one;
}

function filesCell(paths: readonly string[], cfg: ChangelogPolicy): string {
  if (!paths.length) return cfg.none;
  const shown = paths.slice(0, cfg.maxFilesListed).map(code);
  const more = paths.length - shown.length;
  return cell(more > 0 ? `${shown.join(", ")} and ${more} more` : shown.join(", "));
}

function evidenceOf(f: ChangelogFinding, cfg: ChangelogPolicy): string {
  const cites = f.citations.slice(0, cfg.maxCitations).map((c) => {
    const quote = c.quote ? ` "${clip(c.quote, cfg.maxQuoteChars)}"` : "";
    return `R${c.record}${quote}${c.ok ? "" : " (not confirmed by the citation check)"}`;
  });
  const more = f.citations.length - cites.length;
  if (more > 0) cites.push(`and ${more} more`);
  return cites.length ? cites.join(", ") : cfg.none;
}

/** The table row of one change. */
export function changelogRow(change: ChangelogChange, findings: ReadonlyMap<string, ChangelogFinding>, cfg: ChangelogPolicy): string {
  const linked = change.findingIds.map((id) => findings.get(id)).filter((f): f is ChangelogFinding => Boolean(f));
  const join = (values: string[]) => cell(values.length ? values.join("; ") : cfg.none);
  const audit = join([...new Set(linked.map((f) => f.auditName))]);
  const incident = join([...new Set(linked.map((f) => f.incidentId).filter((x): x is string => Boolean(x)))]);
  const finding = join(linked.map((f) => f.title));
  const evidence = linked.length
    ? cell(linked.map((f) => (linked.length > 1 ? `${f.title}: ${evidenceOf(f, cfg)}` : evidenceOf(f, cfg))).join("; "))
    : cell(change.unlinkedReason ? fillTemplate(cfg.unlinked, { reason: change.unlinkedReason }) : cfg.none);
  return `| ${cell(change.message)} | ${filesCell(change.changedPaths, cfg)} | ${audit} | ${incident} | ${finding} | ${evidence} |`;
}

/** The revision's section, markers included, ending without a newline. */
export function renderChangelogSection(cfg: ChangelogPolicy, input: ChangelogInput): string {
  const newest = input.changes.at(-1)?.createdAt;
  const date = input.date ?? (newest ? new Date(newest) : new Date());
  const c = cfg.columns;
  const lines = [
    fillTemplate(cfg.begin, { name: input.name }),
    fillTemplate(cfg.heading, { name: input.name, date: changelogDate(date) }),
    "",
    fillTemplate(cfg.intro, { name: input.name, base: input.baseLabel }),
    "",
  ];
  if (input.changes.length) {
    lines.push(`| ${c.change} | ${c.files} | ${c.audit} | ${c.incident} | ${c.finding} | ${c.evidence} |`, "|---|---|---|---|---|---|");
    for (const ch of input.changes) lines.push(changelogRow(ch, input.findings, cfg));
  } else {
    lines.push(cfg.noChanges);
  }
  lines.push(fillTemplate(cfg.end, { name: input.name }));
  return lines.join("\n");
}

/**
 * Put the section into a change record: replace this revision's earlier
 * section, or insert it after the title line, above the hand-written
 * history. A missing or empty record gets the policy title first.
 */
export function upsertChangelog(existing: string | null, section: string, cfg: ChangelogPolicy, name: string): string {
  const begin = fillTemplate(cfg.begin, { name });
  const end = fillTemplate(cfg.end, { name });
  const text = existing ?? "";
  if (!text.trim()) return `${cfg.title}\n\n${section}\n`;
  const at = text.indexOf(begin);
  const endAt = at >= 0 ? text.indexOf(end, at + begin.length) : -1;
  if (at >= 0 && endAt >= 0) return `${text.slice(0, at)}${section}${text.slice(endAt + end.length)}`;
  const title = /^# .*$/m.exec(text);
  if (!title || text.slice(0, title.index).trim()) return `${section}\n\n${text}`;
  const afterTitle = title.index + title[0].length;
  const rest = text.slice(afterTitle).replace(/^\n+/, "");
  return `${text.slice(0, afterTitle)}\n\n${section}\n\n${rest}`;
}
