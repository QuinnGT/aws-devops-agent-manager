import { showValue, type DiffHunk, type FileDiff, type ValueChange } from "@/server/assets/diff";
import { cn } from "@/lib/utils";
import { DiffCounts } from "./diff-counts";

export { DiffCounts };

/**
 * Diffs in the MASTER "Diffs" style: old and new line numbers, hunk headers,
 * +N and -M counts, long lines that wrap in Unified and Split (the line
 * number and sign stay on the first row; long words break anywhere), and the
 * tint percentages from MASTER "Tokens". Text only: no diff output is ever interpreted as HTML. Render on
 * a card background, which the theme test measures the tints against.
 */

const KIND_TEXT: Record<ValueChange["kind"], string> = { added: "added", removed: "removed", changed: "changed" };

/** Key-level changes (asset.json fields or metadata). Values are shown as JSON text. */
export function ValueChanges({ changes, empty }: { changes: ValueChange[]; empty: string }) {
  if (changes.length === 0) return <p className="px-4 py-3 text-sm text-muted-foreground">{empty}</p>;
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-[13px]">
        <thead>
          <tr className="border-b bg-muted text-left text-xs text-muted-foreground">
            <th scope="col" className="px-4 py-1.5 font-medium">
              Key
            </th>
            <th scope="col" className="px-3 py-1.5 font-medium">
              Before
            </th>
            <th scope="col" className="px-3 py-1.5 font-medium">
              After
            </th>
          </tr>
        </thead>
        <tbody>
          {changes.map((c) => (
            <tr key={c.key} className="border-b align-top last:border-b-0">
              <td className="px-4 py-1.5 font-mono text-xs whitespace-nowrap">
                {c.key} <span className="text-muted-foreground">({KIND_TEXT[c.kind]})</span>
              </td>
              <td className={cn("px-3 py-1.5", c.before !== undefined && "bg-destructive/10")}>
                <pre className="font-mono text-xs whitespace-pre-wrap break-words">{showValue(c.before)}</pre>
              </td>
              <td className={cn("px-3 py-1.5", c.after !== undefined && "bg-success/14")}>
                <pre className="font-mono text-xs whitespace-pre-wrap break-words">{showValue(c.after)}</pre>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

const STATUS_TEXT: Record<FileDiff["status"], string> = {
  added: "Added",
  removed: "Removed",
  modified: "Changed",
  unchanged: "Unchanged",
  "not-comparable": "Changed",
};

export type DiffLayout = "unified" | "split";

interface Numbered {
  kind: "add" | "del" | "ctx" | "meta";
  text: string;
  oldNo: number | null;
  newNo: number | null;
}

/** Old and new line numbers for each line of a hunk. Pure. */
export function numberHunk(h: DiffHunk): Numbered[] {
  let o = h.oldStart;
  let n = h.newStart;
  return h.lines.map((l) => {
    if (l.kind === "ctx") return { ...l, oldNo: o++, newNo: n++ };
    if (l.kind === "del") return { ...l, oldNo: o++, newNo: null };
    if (l.kind === "add") return { ...l, oldNo: null, newNo: n++ };
    return { ...l, oldNo: null, newNo: null };
  });
}

export interface SplitRow {
  left: Numbered | null;
  right: Numbered | null;
}

/** Side-by-side rows: context on both sides, each run of removed lines paired with the added lines after it. Pure. */
export function splitHunk(h: DiffHunk): SplitRow[] {
  const lines = numberHunk(h);
  const rows: SplitRow[] = [];
  let i = 0;
  while (i < lines.length) {
    const l = lines[i]!;
    if (l.kind === "ctx" || l.kind === "meta") {
      rows.push({ left: l, right: l.kind === "ctx" ? l : null });
      i++;
      continue;
    }
    const dels: Numbered[] = [];
    const adds: Numbered[] = [];
    while (i < lines.length && lines[i]!.kind === "del") dels.push(lines[i++]!);
    while (i < lines.length && lines[i]!.kind === "add") adds.push(lines[i++]!);
    for (let k = 0; k < Math.max(dels.length, adds.length); k++) rows.push({ left: dels[k] ?? null, right: adds[k] ?? null });
  }
  return rows;
}

const SIGN: Record<Numbered["kind"], string> = { add: "+", del: "\u2212", ctx: "", meta: "\\" };
const LINE_BG: Record<Numbered["kind"], string> = { add: "bg-success/14", del: "bg-destructive/10", ctx: "", meta: "" };
const SIGN_FG: Record<Numbered["kind"], string> = { add: "text-success-fg", del: "text-destructive-fg", ctx: "text-muted-foreground", meta: "text-muted-foreground" };
const NUM = "w-12 min-w-12 pr-2 text-right align-top text-muted-foreground tabular-nums select-none";
const SIGN_CELL = "w-5 min-w-5 text-center align-top select-none";
/** A line's text: wraps, keeps its spaces, and breaks a word too long for the column. */
const TEXT = "whitespace-pre-wrap [overflow-wrap:anywhere]";

function hunkHeader(h: DiffHunk): string {
  return `@@ -${h.oldStart},${h.oldLines} +${h.newStart},${h.newLines} @@`;
}

function Unified({ file }: { file: FileDiff }) {
  return (
    <table className="w-full table-fixed border-collapse font-mono text-xs leading-5">
      <colgroup>
        <col className="w-12" />
        <col className="w-12" />
        <col className="w-5" />
        <col />
      </colgroup>
      <caption className="sr-only">Unified diff of {file.path}</caption>
      <thead className="sr-only">
        <tr>
          <th scope="col">Old line</th>
          <th scope="col">New line</th>
          <th scope="col">Change</th>
          <th scope="col">Text</th>
        </tr>
      </thead>
      <tbody>
        {file.hunks.map((h, hi) => [
          <tr key={`h${hi}`} className="bg-info/8 text-info-fg">
            <td className={NUM} />
            <td className={NUM} />
            <td className={SIGN_CELL} />
            <td className={cn("pr-4", TEXT)}>{hunkHeader(h)}</td>
          </tr>,
          ...numberHunk(h).map((l, li) => (
            <tr key={`${hi}:${li}`} className={LINE_BG[l.kind]}>
              <td className={NUM}>{l.oldNo ?? ""}</td>
              <td className={NUM}>{l.newNo ?? ""}</td>
              <td className={cn(SIGN_CELL, SIGN_FG[l.kind])}>
                {SIGN[l.kind]}
                {l.kind === "add" ? <span className="sr-only">added</span> : l.kind === "del" ? <span className="sr-only">removed</span> : null}
              </td>
              <td className={cn("pr-4 align-top", TEXT, l.kind === "meta" && "text-muted-foreground italic")}>{l.text}</td>
            </tr>
          )),
        ])}
      </tbody>
    </table>
  );
}

function SplitSide({ line, side }: { line: Numbered | null; side: "old" | "new" }) {
  if (!line) {
    return (
      <>
        <td className={cn(NUM, "bg-muted/60")} />
        <td className={cn(SIGN_CELL, "bg-muted/60")} />
        <td className="bg-muted/60" />
      </>
    );
  }
  const bg = LINE_BG[line.kind];
  return (
    <>
      <td className={cn(NUM, bg)}>{(side === "old" ? line.oldNo : line.newNo) ?? ""}</td>
      <td className={cn(SIGN_CELL, bg, SIGN_FG[line.kind])}>
        {line.kind === "ctx" ? "" : SIGN[line.kind]}
        {line.kind === "add" ? <span className="sr-only">added</span> : line.kind === "del" ? <span className="sr-only">removed</span> : null}
      </td>
      <td className={cn("pr-3 align-top", TEXT, bg, line.kind === "meta" && "text-muted-foreground italic")}>{line.text}</td>
    </>
  );
}

/** Side by side, the halves stay equal and long lines wrap: a line that pushed the other half out of view would defeat the layout. */
function Split({ file }: { file: FileDiff }) {
  return (
    <table className="w-full table-fixed border-collapse font-mono text-xs leading-5">
      <colgroup>
        <col className="w-12" />
        <col className="w-5" />
        <col />
        <col className="w-12" />
        <col className="w-5" />
        <col />
      </colgroup>
      <caption className="sr-only">Side-by-side diff of {file.path}</caption>
      <thead className="sr-only">
        <tr>
          <th scope="col">Old line</th>
          <th scope="col">Change</th>
          <th scope="col">Before</th>
          <th scope="col">New line</th>
          <th scope="col">Change</th>
          <th scope="col">After</th>
        </tr>
      </thead>
      <tbody>
        {file.hunks.map((h, hi) => [
          <tr key={`h${hi}`} className="bg-info/8 text-info-fg">
            <td className={NUM} />
            <td className={SIGN_CELL} />
            <td colSpan={4} className={cn("pr-4", TEXT)}>
              {hunkHeader(h)}
            </td>
          </tr>,
          ...splitHunk(h).map((r, ri) => (
            <tr key={`${hi}:${ri}`} className="align-top">
              <SplitSide line={r.left} side="old" />
              <SplitSide line={r.right} side="new" />
            </tr>
          )),
        ])}
      </tbody>
    </table>
  );
}

/**
 * Line diff of one file: a slim header with the path, status and counts, then
 * the lines (`layout` "unified" by default, or "split"). Server component.
 */
export function FileDiffView({ file, layout = "unified", showHeader = true }: { file: FileDiff; layout?: DiffLayout; showHeader?: boolean }) {
  return (
    <div className="border-b last:border-b-0">
      {showHeader ? (
        <div className="flex min-h-9 items-center justify-between gap-3 border-b bg-muted px-4 py-1.5 text-xs">
          <span className="font-mono break-all">{file.path}</span>
          <span className="flex shrink-0 items-center gap-2 text-muted-foreground">
            {STATUS_TEXT[file.status]}
            {file.added || file.removed ? <DiffCounts added={file.added} removed={file.removed} /> : null}
          </span>
        </div>
      ) : null}
      {file.reason ? (
        <p className="px-4 py-2 text-xs text-muted-foreground">
          {file.reason}. Hashes: <span className="font-mono">{file.beforeSha?.slice(0, 12) ?? "none"}</span> to <span className="font-mono">{file.afterSha?.slice(0, 12) ?? "none"}</span>.
        </p>
      ) : null}
      {file.hunks.length > 0 ? <div className="max-h-[48rem] overflow-auto">{layout === "split" ? <Split file={file} /> : <Unified file={file} />}</div> : null}
    </div>
  );
}
