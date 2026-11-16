import { CircleCheck, CircleX, TriangleAlert } from "lucide-react";
import type { ReactNode } from "react";
import { cn } from "@/lib/utils";
import type { ValidationResult } from "@/server/validation/types";
import { sortValidation } from "./status-words";

const ROW = "grid grid-cols-[16px_minmax(0,1fr)] gap-2 border-b px-4 py-2 text-[13px] last:border-b-0";

/**
 * One row per validation result, errors first: icon, message, then the code
 * (and path, when set) in muted monospace. With no results it shows
 * "No errors or warnings" and the optional `emptyHelp` line. With
 * `fileLink`, a result about a file shows that link on its own line above
 * the message (and the path leaves the code line). With `codeAsDetails`,
 * the code line reads "Details: <code>".
 */
export function ValidationList({
  results,
  emptyHelp,
  className,
  fileLink,
  codeAsDetails = true,
}: {
  results: readonly ValidationResult[];
  emptyHelp?: ReactNode;
  className?: string;
  fileLink?: (r: ValidationResult) => ReactNode | null;
  /** Show the rule code (and path) as a muted "Details: <code>" line, for readers who don't know the codes */
  codeAsDetails?: boolean;
}) {
  if (results.length === 0) {
    return (
      <div className={cn(ROW, className)}>
        <CircleCheck className="mt-0.5 size-4 text-success-fg" aria-hidden />
        <div>
          No errors or warnings
          {emptyHelp ? <p className="text-xs text-muted-foreground">{emptyHelp}</p> : null}
        </div>
      </div>
    );
  }
  return (
    <ul className={className}>
      {sortValidation(results).map((r, i) => {
        const error = r.level === "error";
        const Icon = error ? CircleX : TriangleAlert;
        const link = fileLink?.(r) ?? null;
        return (
          <li key={`${i}:${r.code}`} className={ROW}>
            <Icon className={cn("mt-0.5 size-4", error ? "text-destructive-fg" : "text-warning-fg")} aria-hidden />
            <div className="min-w-0">
              <span className="sr-only">{error ? "Error: " : "Warning: "}</span>
              {link ? <div className="break-all">{link}</div> : null}
              <p className="break-words">{r.message}</p>
              {codeAsDetails ? (
                <p className="text-xs break-all text-muted-foreground">
                  Details: <span className="font-mono">{r.code}</span>
                  {r.path && !link ? <span className="font-mono"> · {r.path}</span> : null}
                </p>
              ) : (
                <p className="font-mono text-xs break-all text-muted-foreground">
                  {r.code}
                  {r.path && !link ? ` · ${r.path}` : null}
                </p>
              )}
            </div>
          </li>
        );
      })}
    </ul>
  );
}
