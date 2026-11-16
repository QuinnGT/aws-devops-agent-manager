import type { FileDiff, ValueChange } from "@/server/assets/diff";
import { showValue } from "@/server/assets/diff";
import { cn } from "@/lib/utils";
import { diffRows } from "./diff-rows";

/** A line's text: wraps, keeps its spaces, and breaks a word too long for the column. */
const TEXT = "whitespace-pre-wrap [overflow-wrap:anywhere]";

/**
 * A unified diff in the MASTER "Diffs" style: old and new line numbers, hunk
 * headers, +/− signs, token tints (added 14%, deleted 10%, hunk 8%). Long
 * lines wrap: the numbers and sign stay on the first row, long words break
 * anywhere, nothing scrolls sideways. Content is plain text, never HTML.
 * No hooks, so it renders on the server or inside a client component.
 */
export function UnifiedDiff({ file, label }: { file: FileDiff; label?: string }) {
  if (file.reason) {
    return <p className="px-4 py-3 text-[13px] text-muted-foreground">{file.reason}.</p>;
  }
  if (file.hunks.length === 0) {
    return <p className="px-4 py-3 text-[13px] text-muted-foreground">{file.status === "unchanged" ? "No change in this file." : "No line changes."}</p>;
  }
  const rows = diffRows(file.hunks);
  return (
    <div role="region" aria-label={label ?? `Unified diff of ${file.path}`}>
      <table className="w-full table-fixed border-collapse font-mono text-[12.5px] leading-[1.6]">
        <colgroup>
          <col className="w-10" />
          <col className="w-10" />
          <col className="w-5" />
          <col />
        </colgroup>
        <tbody>
          {rows.map((r, i) => {
            if (r.kind === "hunk") {
              return (
                <tr key={i} className="bg-info/8 text-info-fg">
                  <td className="w-10 select-none" aria-hidden />
                  <td className="w-10 select-none" aria-hidden />
                  <td className="w-5 select-none" aria-hidden />
                  <td className={cn("pr-4", TEXT)}>{r.text}</td>
                </tr>
              );
            }
            if (r.kind === "meta") {
              return (
                <tr key={i} className="text-muted-foreground italic">
                  <td colSpan={3} aria-hidden />
                  <td className={cn("pr-4", TEXT)}>{`\\ ${r.text}`}</td>
                </tr>
              );
            }
            return (
              <tr key={i} className={cn("align-top", r.kind === "add" && "bg-success/14", r.kind === "del" && "bg-destructive/10")}>
                <td className="w-10 pr-2 text-right text-muted-foreground tabular-nums select-none">{r.old ?? ""}</td>
                <td className="w-10 pr-2 text-right text-muted-foreground tabular-nums select-none">{r.new ?? ""}</td>
                <td className={cn("w-5 text-center select-none", r.kind === "add" ? "text-success-fg" : r.kind === "del" ? "text-destructive-fg" : "text-muted-foreground")}>
                  {r.kind === "add" ? "+" : r.kind === "del" ? "−" : ""}
                  <span className="sr-only">{r.kind === "add" ? "added" : r.kind === "del" ? "removed" : ""}</span>
                </td>
                <td className={cn("pr-4", TEXT)}>{r.text}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

/** "+N −M" in the diff colors. */
export function DiffCounts({ added, removed, className }: { added: number; removed: number; className?: string }) {
  return (
    <span className={cn("inline-flex items-center gap-1.5 font-mono text-xs font-semibold tabular-nums", className)}>
      <span className="text-success-fg">+{added}</span>
      <span className="text-destructive-fg">−{removed}</span>
      <span className="sr-only">
        {added} lines added, {removed} lines removed
      </span>
    </span>
  );
}

/** Metadata keys that change: Key, then the two sides. Values are JSON text. */
export function MetadataChanges({ changes, before = "Live", after = "Planned", empty }: { changes: readonly ValueChange[]; before?: string; after?: string; empty: string }) {
  if (changes.length === 0) return <p className="px-4 py-3 text-[13px] text-muted-foreground">{empty}</p>;
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-[13px]">
        <thead>
          <tr className="border-b bg-muted/50 text-left text-xs text-muted-foreground">
            <th scope="col" className="px-4 py-2 font-medium">
              Key
            </th>
            <th scope="col" className="px-4 py-2 font-medium">
              {before}
            </th>
            <th scope="col" className="px-4 py-2 font-medium">
              {after}
            </th>
          </tr>
        </thead>
        <tbody>
          {changes.map((c) => (
            <tr key={c.key} className="border-b align-top last:border-b-0">
              <td className="px-4 py-2 font-mono text-xs">{c.key}</td>
              <td className="px-4 py-2">
                <pre className={cn("font-mono text-xs whitespace-pre-wrap [overflow-wrap:anywhere]", c.kind !== "added" && "rounded-sm bg-destructive/10 px-1")}>{c.kind === "added" ? "Not set" : showValue(c.before)}</pre>
              </td>
              <td className="px-4 py-2">
                <pre className={cn("font-mono text-xs whitespace-pre-wrap [overflow-wrap:anywhere]", c.kind !== "removed" && "rounded-sm bg-success/14 px-1")}>{c.kind === "removed" ? "Removed" : showValue(c.after)}</pre>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
