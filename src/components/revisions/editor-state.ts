import { diffText } from "@/server/assets/diff";

/**
 * Pure state of the revision editor (revision-detail.md, option 1): files
 * opened in this browser tab with the text they had at the branch head,
 * which of them are edited, their +/− counts, the save dialog's changelog
 * preview and finding search. Unit-tested; no React.
 */

export interface OpenFile {
  path: string;
  /** Text at the branch head, or null for a file added in this tab */
  base: string | null;
  /** Text in the editor */
  text: string;
  /** "text" files can be edited; binary and too-large files are shown as a note */
  kind: "text" | "binary" | "too-large";
  size: number;
  /** Deleted in this tab: the save removes it from the package */
  deleted?: boolean;
}

export type OpenFiles = Readonly<Record<string, OpenFile>>;

export function isEdited(f: OpenFile): boolean {
  if (f.deleted) return f.base !== null;
  return f.kind === "text" && f.base !== f.text;
}

/** Delete a file in the editor: a file added in this tab just goes, a file of the branch is deleted by the next save. */
export function deleteOpenFile(files: OpenFiles, path: string): Record<string, OpenFile> {
  const f = files[path];
  const { [path]: _gone, ...rest } = files;
  if (!f || f.base === null) return rest;
  return { ...files, [path]: { ...f, deleted: true } };
}

/** Undo a delete: the file comes back with the text it had in the editor. */
export function restoreOpenFile(files: OpenFiles, path: string): Record<string, OpenFile> {
  const f = files[path];
  return f ? { ...files, [path]: { ...f, deleted: false } } : { ...files };
}

/** Rename a text file: a new file at `to` with its text, and `from` deleted (or dropped when it was new in this tab). */
export function renameOpenFile(files: OpenFiles, from: string, to: string): Record<string, OpenFile> {
  const f = files[from];
  if (!f || f.kind !== "text") return { ...files };
  return { ...deleteOpenFile(files, from), [to]: { path: to, base: null, text: f.text, kind: "text", size: f.size } };
}

/** Edited files in path order: what a save sends. */
export function editedFiles(files: OpenFiles): OpenFile[] {
  return Object.values(files)
    .filter(isEdited)
    .sort((a, b) => a.path.localeCompare(b.path));
}

/** Lines added and removed between the head text and the editor text. */
export function lineCounts(before: string | null, after: string): { added: number; removed: number } {
  const hunks = diffText(before ?? "", after) ?? [];
  let added = 0;
  let removed = 0;
  for (const h of hunks) {
    for (const l of h.lines) {
      if (l.kind === "add") added++;
      else if (l.kind === "del") removed++;
    }
  }
  return { added, removed };
}

/** Lines added and removed over many files. */
export function diffTotals(files: readonly { added: number; removed: number }[]): { added: number; removed: number } {
  return files.reduce((t, f) => ({ added: t.added + f.added, removed: t.removed + f.removed }), { added: 0, removed: 0 });
}

/** The changed files split into the ones a person edited and the ones the build wrote (`builtPaths`); unchanged files are dropped. */
export function diffGroups<T extends { path: string; status: string }>(files: readonly T[], builtPaths: readonly string[]): { edited: T[]; built: T[] } {
  const built = new Set(builtPaths);
  const changed = files.filter((f) => f.status !== "unchanged");
  return { edited: changed.filter((f) => !built.has(f.path)), built: changed.filter((f) => built.has(f.path)) };
}

/** "CHANGELOG.md, VALIDATION.json" or "a, b, c and 4 more". */
export function namesText(names: readonly string[], max = 3): string {
  const unique = [...new Set(names)];
  if (unique.length <= max) return unique.join(", ");
  return `${unique.slice(0, max).join(", ")} and ${unique.length - max} more`;
}

/** After a save went through: every saved file's head text is its editor text. */
export function markSaved(files: OpenFiles, saved: readonly string[]): Record<string, OpenFile> {
  const out: Record<string, OpenFile> = { ...files };
  for (const p of saved) {
    const f = out[p];
    if (f?.deleted) delete out[p];
    else if (f) out[p] = { ...f, base: f.text };
  }
  return out;
}

/** A new file's path: package-relative, in a folder, no "..", absolute paths or backslashes, not taken. */
export function newFileProblem(path: string, existing: Iterable<string>): string | null {
  const p = path.trim();
  if (!p) return "Enter a path, for example memory/incident-patterns/new-pattern.md.";
  if (p.startsWith("/") || p.includes("\\") || p.split("/").some((s) => s === "" || s === "." || s === "..")) return "Use a path inside the package, with folders separated by /.";
  if (/[\u0000-\u001f\u007f]/.test(p)) return "Use a path without control characters.";
  for (const e of existing) if (e === p) return "A file with this path already exists.";
  return null;
}

export interface PreviewFinding {
  id: string;
  incidentId: string | null;
  title: string;
  records: number[];
}

/** The changelog entry a save adds (revision-detail.md, "Changelog entry preview"). */
export function changelogPreview(message: string, paths: readonly string[], findings: readonly PreviewFinding[], unlinkedReason: string | null): { title: string; files: string; evidence: string } {
  const title = message.replace(/\s+/g, " ").trim() || "Write a message";
  const evidence = findings.length
    ? findings.map((f) => `${f.incidentId ?? f.title}${f.records.length ? ` (${f.records.map((r) => `R${r}`).join(", ")})` : ""}`).join(", ")
    : unlinkedReason?.trim()
      ? `Not linked to a finding: ${unlinkedReason.trim()}`
      : "None linked yet";
  return { title, files: paths.join(", ") || "None", evidence };
}

export interface SearchableFinding {
  title: string;
  incidentId: string | null;
  kindLabel: string;
  auditName: string;
  /** The finding's text values, when known */
  text?: string;
}

/** Findings whose incident, title, text, kind or audit contains every word of the query. */
export function searchFindings<T extends SearchableFinding>(list: readonly T[], q: string): T[] {
  const words = q.toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return [...list];
  return list.filter((f) => {
    const hay = `${f.incidentId ?? ""} ${f.title} ${f.text ?? ""} ${f.kindLabel} ${f.auditName}`.toLowerCase();
    return words.every((w) => hay.includes(w));
  });
}

const GENERIC_FILE = new Set(["skill", "store", "readme", "index", "agents", "changelog", "validation"]);

/**
 * The names a finding would use for the edited files: each file name
 * ("incident-rca.md"), its stem when it is a compound name ("incident-rca"),
 * and the asset folder of a skill ("change-window-search"). Generic
 * names (SKILL.md, STORE.md, README.md) count only through their folder.
 */
export function fileTerms(paths: readonly string[]): string[] {
  const out = new Set<string>();
  for (const p of paths) {
    const parts = p.split("/").filter(Boolean);
    const file = parts.at(-1) ?? "";
    const stem = file.replace(/\.[^.]+$/, "");
    if (!GENERIC_FILE.has(stem.toLowerCase())) {
      out.add(file.toLowerCase());
      if (/[-_]/.test(stem) && stem.length >= 4) out.add(stem.toLowerCase());
    }
    if (parts[0] === "skills" && parts.length > 2 && parts[1]) out.add(parts[1].toLowerCase());
  }
  return [...out];
}

/**
 * The save dialog's order: findings whose title or text names an edited file
 * or asset first, then findings of the same incidents, then the rest (each
 * group keeps the given order, so earlier links stay on top within it).
 */
export function rankFindings<T extends SearchableFinding>(list: readonly T[], paths: readonly string[]): { related: T[]; rest: T[] } {
  const terms = fileTerms(paths);
  if (!terms.length) return { related: [], rest: [...list] };
  const mentions = (f: T) => {
    const hay = `${f.title}\n${f.text ?? ""}`.toLowerCase();
    return terms.some((t) => hay.includes(t));
  };
  const direct = list.filter(mentions);
  const incidents = new Set(direct.map((f) => f.incidentId).filter((x): x is string => Boolean(x)));
  const sameIncident = list.filter((f) => !direct.includes(f) && f.incidentId !== null && incidents.has(f.incidentId));
  const related = [...direct, ...sameIncident];
  return { related, rest: list.filter((f) => !related.includes(f)) };
}

export type FindingGroupKey = "sent" | "related" | "rest";

export interface FindingGroup<T> {
  key: FindingGroupKey;
  label: string;
  items: T[];
}

/**
 * The save dialog's groups of findings: the ones sent to this revision from an
 * audit (`toAddress`), then those that name an edited file (rankFindings), then
 * the rest. Empty groups are left out; each keeps the given order.
 */
export function groupFindings<T extends SearchableFinding & { toAddress?: boolean }>(list: readonly T[], paths: readonly string[]): FindingGroup<T>[] {
  const sent = list.filter((f) => f.toAddress);
  const ranked = rankFindings(
    list.filter((f) => !f.toAddress),
    paths,
  );
  return [
    { key: "sent" as const, label: "Sent to this revision", items: sent },
    { key: "related" as const, label: "About the files you changed", items: ranked.related },
    { key: "rest" as const, label: "Other accepted findings", items: ranked.rest },
  ].filter((g) => g.items.length > 0);
}

/** The findings to tick when the save dialog opens: those sent to the revision, up to the most one save may link. */
export function preselectedFindings(list: readonly { id: string; toAddress?: boolean }[], max: number): { ids: string[]; left: number } {
  const sent = list.filter((f) => f.toAddress).map((f) => f.id);
  return { ids: sent.slice(0, Math.max(0, max)), left: Math.max(0, sent.length - Math.max(0, max)) };
}

/** A finding's title without the incident prefix the title may carry, with the incident ID to show before it. "INCIDENT-1: Ruled out" gives ("INCIDENT-1", "Ruled out"). */
export function incidentAndText(title: string, incidentId: string | null): { incident: string | null; text: string } {
  if (incidentId && title.startsWith(`${incidentId}: `)) return { incident: incidentId, text: title.slice(incidentId.length + 2) };
  return { incident: incidentId, text: title };
}

export type UnlinkedRule = "reason" | "refuse" | "allow";

/** Why "Save and build" can't be pressed yet, or null. */
export function saveButtonReason(s: { message: string; findings: number; reason: string; rule: UnlinkedRule; reasonMinChars: number; messageMaxChars: number; files: number; maxFindings?: number }): string | null {
  if (!s.files) return "Edit a file first.";
  const msg = s.message.trim();
  if (!msg) return "Write a message.";
  if (msg.replace(/\s+/g, " ").length > s.messageMaxChars) return `Keep the message to ${s.messageMaxChars} characters or fewer.`;
  if (s.maxFindings !== undefined && s.findings > s.maxFindings) return `One save can link at most ${s.maxFindings} findings.`;
  if (s.findings > 0 || s.rule === "allow") return null;
  if (s.rule === "refuse") return "Link at least one accepted finding.";
  if (s.reason.trim().length < Math.max(1, s.reasonMinChars)) return "Link at least one accepted finding, or say why the change is needed.";
  return null;
}

/** The title of a finding with its incident prefix split off, so the incident can be bold ("INCIDENT-31808", ": Ruled out ..."). */
export function splitIncident(title: string, incidentId: string | null): { incident: string | null; rest: string } {
  if (incidentId && title.startsWith(`${incidentId}: `)) return { incident: incidentId, rest: title.slice(incidentId.length) };
  return { incident: null, rest: title };
}

/** The fix shape of a validation result (src/server/validation/types.ts QuickFix), kept structural so this module stays client-safe. */
export interface EditorFix {
  label: string;
  from?: string;
  edits: ({ kind: "replace-lines"; line: number; count: number; expect: string; text: string } | { kind: "rename"; to: string })[];
}

/**
 * Apply a one-click fix to an open text file: each replace-lines edit only
 * while its lines still read what the build saw, then a rename. Returns the
 * new files, the path the file ends at and the first line changed, or the
 * reason it can't apply. Pure.
 */
export function applyQuickFix(files: OpenFiles, path: string, fix: EditorFix): { files: Record<string, OpenFile>; path: string; line: number | null } | { error: string } {
  const f = files[path];
  if (!f || f.kind !== "text" || f.deleted) return { error: "Open the file first." };
  const eol = f.text.includes("\r\n") ? "\r\n" : "\n";
  let lines = f.text.split(/\r?\n/);
  let first: number | null = null;
  let to: string | null = null;
  for (const e of fix.edits) {
    if (e.kind === "rename") {
      to = e.to;
      continue;
    }
    const now = lines.slice(e.line - 1, e.line - 1 + e.count).join("\n");
    if (now !== e.expect.replace(/\r\n/g, "\n")) return { error: "The file changed since the last build. Save it to check it again." };
    lines = [...lines.slice(0, e.line - 1), ...e.text.split("\n"), ...lines.slice(e.line - 1 + e.count)];
    first = first === null ? e.line : Math.min(first, e.line);
  }
  let out: Record<string, OpenFile> = { ...files, [path]: { ...f, text: lines.join(eol) } };
  if (to && to !== path) {
    if (out[to] && !out[to]!.deleted) return { error: `${to} already exists.` };
    out = renameOpenFile(out, path, to);
  }
  return { files: out, path: to ?? path, line: first };
}
