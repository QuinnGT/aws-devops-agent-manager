import { CircleX, TriangleAlert } from "lucide-react";
import Link from "next/link";
import { cn } from "@/lib/utils";
import type { AssetProblems, RowNote } from "./mapping";

/**
 * The problems of one asset, under its row in the type table: each sentence
 * once, with how many times it applies and the engine's messages in Details.
 */
export function RowNotesList({ notes }: { notes: readonly RowNote[] }) {
  return (
    <ul className="grid gap-1.5">
      {notes.map((n, i) => {
        const error = n.level === "error";
        const Icon = error ? CircleX : TriangleAlert;
        return (
          <li key={i} className="grid grid-cols-[16px_minmax(0,1fr)] gap-2 text-[13px]">
            <Icon className={cn("mt-0.5 size-4", error ? "text-destructive-fg" : "text-warning-fg")} aria-hidden />
            <div className="min-w-0">
              <span className="sr-only">{error ? "Error: " : "Warning: "}</span>
              {n.line ? <span className="mr-1.5 font-mono text-xs text-muted-foreground">Line {n.line}</span> : null}
              <span className="break-words whitespace-normal">{n.text}</span>
              {n.count > 1 ? <span className="text-muted-foreground tabular-nums"> · {n.count} times</span> : null}
              {n.fixable ? <span className="text-success-fg"> · One-click fix in a revision</span> : null}
              <details className="text-xs text-muted-foreground">
                <summary className="w-fit cursor-pointer underline-offset-4 hover:text-foreground hover:underline">Details</summary>
                <ul className="mt-0.5 grid gap-0.5 font-mono break-all whitespace-normal">
                  {n.details.map((d, j) => (
                    <li key={j}>{d}</li>
                  ))}
                </ul>
              </details>
            </div>
          </li>
        );
      })}
    </ul>
  );
}

/**
 * The side list of the import's problems by asset: each asset with its
 * error and warning counts, linking to its row in the type table, where the
 * problems are listed.
 */
export function ProblemsByAsset({ assets, href }: { assets: readonly AssetProblems[]; href: (a: AssetProblems) => string }) {
  return (
    <ul>
      {assets.map((a) => {
        const error = a.errors > 0;
        const Icon = error ? CircleX : TriangleAlert;
        const counts = [a.errors ? `${a.errors} ${a.errors === 1 ? "error" : "errors"}` : null, a.warnings ? `${a.warnings} ${a.warnings === 1 ? "warning" : "warnings"}` : null].filter(Boolean).join(", ");
        return (
          <li key={`${a.assetType}:${a.rowKey}`} className="grid grid-cols-[16px_minmax(0,1fr)_auto] items-start gap-2 border-b px-4 py-2 text-[13px] last:border-b-0">
            <Icon className={cn("mt-0.5 size-4", error ? "text-destructive-fg" : "text-warning-fg")} aria-hidden />
            <Link href={href(a)} className="inline-block min-h-6 min-w-0 font-medium break-words underline-offset-4 hover:underline">
              {a.name}
            </Link>
            <span className="text-xs whitespace-nowrap text-muted-foreground tabular-nums">{counts}</span>
          </li>
        );
      })}
    </ul>
  );
}
