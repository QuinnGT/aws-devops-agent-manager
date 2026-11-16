import { CircleCheck, CircleX, TriangleAlert } from "lucide-react";
import { cn } from "@/lib/utils";
import type { PlainResult } from "./mapping";

const ROW = "grid grid-cols-[16px_minmax(0,1fr)] gap-2 border-b px-4 py-2 text-[13px] last:border-b-0";

/**
 * The import's errors and warnings in plain words (`plainResult`), errors
 * first, each with a muted "Details" disclosure holding the engine's message,
 * the asset ID it names and the rule code. Same look as ValidationList, which
 * shows the code as a line of its own.
 */
export function ImportResults({ results }: { results: readonly PlainResult[] }) {
  if (results.length === 0) {
    return (
      <div className={ROW}>
        <CircleCheck className="mt-0.5 size-4 text-success-fg" aria-hidden />
        <div>No errors or warnings</div>
      </div>
    );
  }
  const sorted = [...results.filter((r) => r.level === "error"), ...results.filter((r) => r.level !== "error")];
  return (
    <ul>
      {sorted.map((r, i) => {
        const error = r.level === "error";
        const Icon = error ? CircleX : TriangleAlert;
        return (
          <li key={i} className={ROW}>
            <Icon className={cn("mt-0.5 size-4", error ? "text-destructive-fg" : "text-warning-fg")} aria-hidden />
            <div className="min-w-0">
              <span className="sr-only">{error ? "Error: " : "Warning: "}</span>
              <p className="break-words">{r.text}</p>
              <details className="text-xs text-muted-foreground">
                <summary className="w-fit cursor-pointer underline-offset-4 hover:text-foreground hover:underline">Details</summary>
                <p className="mt-0.5 font-mono break-all">{r.details}</p>
              </details>
            </div>
          </li>
        );
      })}
    </ul>
  );
}
