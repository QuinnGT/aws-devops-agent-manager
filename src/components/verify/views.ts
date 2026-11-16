import type { LiveCheckResult } from "@/server/verify/types";
import type { ReadsCheckView, ReadsFileView, RecordLink } from "@/server/verify/loaders";
import type { FileVerdict, ReadOutcome, SkippedAsset } from "@/server/verify/types";
import { READ_COUNT_WORDS, SKIPPED_WORDS, VERDICT_WORDS, type VerdictTone } from "./words";

/**
 * The agent-read table of the release Verification tab, built from a reads
 * result and (for the "requested, nothing returned" reason) the last live
 * result. Pure; unit-tested.
 */

export type FileShow = "look" | "all";

export interface FileRowView {
  key: string;
  assetType: string;
  name: string;
  /** "Memory in runbooks", "Skill" */
  typeLine: string;
  /** "3 of 14"; null when the check didn't compare the file */
  requested: string | null;
  words: string;
  tone: VerdictTone;
  /** The muted line under the words */
  reason: string | null;
  /** The first example record, and how many more investigations had the same outcome */
  record: { href: string; text: string } | null;
  more: number;
  needsLook: boolean;
  /** This release changed the asset (new content or metadata, or new in it) */
  changed: boolean;
}

const WARN: ReadonlySet<FileVerdict> = new Set(["older-body", "other-body", "newer-body", "requested-no-body"]);
const isInactive = (status: string | null | undefined) => typeof status === "string" && status.toUpperCase() === "INACTIVE";
const plural = (n: number, one: string, other: string) => `${n} ${n === 1 ? one : other}`;
const percent = (share: number) => `${Math.round(share * 100)}%`;

/**
 * "Needs a look": every file whose body wasn't the release's, plus
 * never-requested files that are Active in the release and that the release
 * changed. A file the release didn't change and the agent never asked for
 * isn't a problem with the release. `changed` undefined (the release's
 * changes aren't known): every Active never-requested file counts.
 */
export function needsALook(f: Pick<ReadsFileView, "verdict" | "releaseStatus">, changed?: boolean): boolean {
  return WARN.has(f.verdict) || (f.verdict === "not-requested" && !isInactive(f.releaseStatus) && changed !== false);
}

/** Why the agent got nothing back for a file, from the last live check: deleted or switched off since the release. */
function noBodyReason(f: ReadsFileView, live: LiveCheckResult | null): string | null {
  const row = live?.rows.find((r) => r.release?.assetId === f.assetId);
  if (!row) return null;
  if (row.outcome === "missing") return "Deleted from the live space since the release";
  if (isInactive(row.live?.status)) return "Inactive in the live space";
  return null;
}

export function reasonLine(f: ReadsFileView, ctx: { live: LiveCheckResult | null; stores: ReadsCheckView["stores"] }): string | null {
  switch (f.verdict) {
    case "older-body":
    case "newer-body": {
      const v = f.matchedVersions.find((m) => m.relation === (f.verdict === "older-body" ? "older" : "newer"));
      return v ? `Matches v${v.version}; the release has v${f.releaseVersion}` : null;
    }
    case "near-release":
    case "other-body":
      return f.worstShares ? `${percent(f.worstShares.pkg)} of its lines matched` : null;
    case "requested-no-body":
      return noBodyReason(f, ctx.live);
    case "not-requested": {
      if (isInactive(f.releaseStatus)) return SKIPPED_WORDS.inactive.reason;
      const store = f.store ? ctx.stores.find((s) => s.store === f.store) : null;
      return store && store.referencedIn > 0 ? `Store ${store.store} was read in ${plural(store.referencedIn, "investigation", "investigations")}` : null;
    }
    default:
      return null;
  }
}

/** Link text of an example record: "<investigation title> · R<n>". */
export function recordText(e: Pick<RecordLink, "title" | "incidentId" | "taskId" | "n">): string {
  const title = e.title?.trim() || e.incidentId || e.taskId;
  return e.n !== null ? `${title} · R${e.n}` : title;
}

/** The outcomes whose records a row links to. */
function outcomesOf(verdict: FileVerdict): ReadOutcome[] {
  return verdict === "release-body" || verdict === "near-release" ? ["release-body", "near-release"] : [verdict];
}

function recordOf(f: ReadsFileView): { record: FileRowView["record"]; more: number } {
  if (f.verdict === "not-requested") return { record: null, more: 0 };
  const outcomes = outcomesOf(f.verdict);
  const first = outcomes.flatMap((o) => f.examples[o] ?? [])[0];
  if (!first) return { record: null, more: 0 };
  const total = outcomes.reduce((n, o) => n + (f.counts[o] ?? 0), 0);
  return { record: { href: first.href, text: recordText(first) }, more: Math.max(0, total - 1) };
}

export function typeLine(typeLabel: string, store: string | null): string {
  return store ? `${typeLabel} in ${store}` : typeLabel;
}

/** `changed`: the asset IDs this release changed; null or absent when unknown. */
export function fileRow(
  f: ReadsFileView,
  ctx: { live: LiveCheckResult | null; stores: ReadsCheckView["stores"]; name?: string; changed?: ReadonlySet<string> | null },
): FileRowView {
  const w = VERDICT_WORDS[f.verdict];
  const changed = ctx.changed ? ctx.changed.has(f.assetId) : undefined;
  return {
    key: f.rowKey,
    assetType: f.assetType,
    name: ctx.name ?? f.assetName,
    typeLine: typeLine(f.typeLabel, f.store),
    requested: `${f.requested} of ${f.investigations}`,
    words: w.words,
    tone: w.tone,
    reason: reasonLine(f, ctx),
    ...recordOf(f),
    needsLook: needsALook(f, changed),
    changed: changed === true,
  };
}

/** A release asset the check skipped (inactive, content not in git). Types it never compares and managed memories aren't rows; the footer counts them. */
export function skippedRow(s: SkippedAsset, typeLabel: string, store: string | null, changed?: ReadonlySet<string> | null): FileRowView | null {
  if (s.reason === "not-compared" || s.reason === "managed") return null;
  const w = SKIPPED_WORDS[s.reason];
  return {
    key: `skipped:${s.assetType}:${s.assetId}`,
    assetType: s.assetType,
    name: s.name,
    typeLine: typeLine(typeLabel, store),
    requested: null,
    words: w.words,
    tone: "muted",
    reason: w.reason,
    record: null,
    more: 0,
    needsLook: false,
    changed: Boolean(changed?.has(s.assetId)),
  };
}

/** The release's changed assets first, then the other rows that need a look, then the rest, keeping the result's verdict order inside each part. */
export function orderRows(rows: readonly FileRowView[]): FileRowView[] {
  return [...rows.filter((r) => r.changed), ...rows.filter((r) => !r.changed && r.needsLook), ...rows.filter((r) => !r.changed && !r.needsLook)];
}

/** The default view ("look") holds the release's changed assets and the other rows that need a look. */
export function inLookView(r: Pick<FileRowView, "changed" | "needsLook">): boolean {
  return r.changed || r.needsLook;
}

export function visibleRows(rows: readonly FileRowView[], o: { show: FileShow; type: string | null }): FileRowView[] {
  return rows.filter((r) => (o.show === "all" || inLookView(r)) && (!o.type || r.assetType === o.type));
}

const joinAnd = (parts: readonly string[]) => (parts.length <= 1 ? (parts[0] ?? "") : `${parts.slice(0, -1).join(", ")} and ${parts.at(-1)}`);

/**
 * The answer above the table: "Of the 2 assets this release changed, the
 * agent read 1 as released and 1 as an older version; 0 were never requested
 * in 5 investigations." Counted over the assets this release changed only;
 * changed assets the check doesn't compare (instruction files, memory stores)
 * or doesn't offer (inactive) are said in a sentence of their own. Null when
 * the release's changes aren't known. Pure.
 */
export function changedSummary(o: {
  changes: { previous: string | null; assetIds: readonly string[] } | null | undefined;
  files: readonly Pick<ReadsFileView, "assetId" | "verdict">[];
  skipped: readonly Pick<SkippedAsset, "assetId" | "assetType" | "reason">[];
  investigations: number;
  /** Plural noun of an asset type, for the "not compared" sentence ("instruction files") */
  typeNoun: (assetType: string) => string;
}): string | null {
  if (!o.changes) return null;
  const ids = new Set(o.changes.assetIds);
  const n = ids.size;
  const scope = o.changes.previous ? `this release changed since ${o.changes.previous}` : "in this release (the space's first)";
  if (n === 0) return o.changes.previous ? `This release changed no assets since ${o.changes.previous}, so there is nothing new for the agent to read.` : "This release has no assets.";
  const c = { released: 0, older: 0, newer: 0, other: 0, noBody: 0, never: 0 };
  const seen = new Set<string>();
  for (const f of o.files) {
    if (!ids.has(f.assetId) || seen.has(f.assetId)) continue;
    seen.add(f.assetId);
    if (f.verdict === "release-body" || f.verdict === "near-release") c.released++;
    else if (f.verdict === "older-body") c.older++;
    else if (f.verdict === "newer-body") c.newer++;
    else if (f.verdict === "other-body") c.other++;
    else if (f.verdict === "requested-no-body") c.noBody++;
    else c.never++;
  }
  const off: string[] = [];
  const notCompared = new Set<string>();
  let notComparedCount = 0;
  for (const s of o.skipped) {
    if (!ids.has(s.assetId) || seen.has(s.assetId)) continue;
    seen.add(s.assetId);
    if (s.reason === "inactive") off.push(s.assetId);
    else {
      notComparedCount++;
      notCompared.add(s.reason === "managed" ? "memories in managed stores" : s.reason === "not-in-git" ? "content not in the history repository" : o.typeNoun(s.assetType));
    }
  }
  // Changed assets the check has no row for (it ran before they existed, or the type isn't compared)
  const unaccounted = n - seen.size;

  const read = [`${c.released} as released`, `${c.older} as an older version`];
  if (c.newer) read.push(`${c.newer} as a newer version`);
  if (c.other) read.push(`${c.other} as a different version`);
  const were = (k: number) => (k === 1 ? "was" : "were");
  const inN = `in ${plural(o.investigations, "investigation", "investigations")}`;
  let text = `Of the ${plural(n, "asset", "assets")} ${scope}, the agent read ${joinAnd(read)}; ${c.never} ${were(c.never)} never requested ${inN}.`;
  if (c.noBody) text += ` The agent asked for ${c.noBody} more and got nothing back.`;
  if (off.length) text += ` ${off.length} ${off.length === 1 ? "is" : "are"} switched off in this release, so the agent isn't offered ${off.length === 1 ? "it" : "them"}.`;
  if (notComparedCount) text += ` ${notComparedCount} ${notComparedCount === 1 ? "isn't" : "aren't"} compared (${joinAnd([...notCompared])}).`;
  if (unaccounted > 0) text += ` ${unaccounted} ${unaccounted === 1 ? "isn't" : "aren't"} in the last check; run it again.`;
  return text;
}

/** Files per counts-row group; the groups with `always: false` are left out at zero. */
export function readCounts(files: readonly Pick<ReadsFileView, "verdict">[]): { key: string; words: string; tone: VerdictTone; n: number }[] {
  const n = { release: 0, older: 0, newer: 0, other: 0, "no-body": 0, never: 0 };
  for (const f of files) {
    if (f.verdict === "release-body" || f.verdict === "near-release") n.release++;
    else if (f.verdict === "older-body") n.older++;
    else if (f.verdict === "newer-body") n.newer++;
    else if (f.verdict === "other-body") n.other++;
    else if (f.verdict === "requested-no-body") n["no-body"]++;
    else n.never++;
  }
  return READ_COUNT_WORDS.filter((c) => c.always || n[c.key] > 0).map((c) => ({ key: c.key, words: c.words, tone: c.tone, n: n[c.key] }));
}

/** "At apply" row of the live card. */
export function atApplyText(a: { total: number; matched: number }): { ok: boolean; lead: string } {
  if (a.total > 0 && a.matched === a.total) return { ok: true, lead: `At apply, all ${plural(a.total, "asset", "assets")} matched.` };
  return { ok: false, lead: `At apply, ${a.total - a.matched} of ${plural(a.total, "asset", "assets")} didn't match.` };
}

/** Live counts in the card's order, with the tone of each number. */
export function liveCounts(c: LiveCheckResult["counts"]): { key: string; n: number; words: string; tone: "default" | "warning" | "destructive" }[] {
  return [
    { key: "matches", n: c.matches, words: "match", tone: "default" },
    { key: "changed", n: c.changed, words: "changed", tone: c.changed > 0 ? "warning" : "default" },
    { key: "missing", n: c.missing, words: "missing", tone: c.missing > 0 ? "destructive" : "default" },
    { key: "added", n: c.added, words: "added since", tone: "default" },
  ];
}

export function differences(c: LiveCheckResult["counts"]): number {
  return c.changed + c.missing + c.added;
}
