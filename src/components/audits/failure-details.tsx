import type { FailureGroup } from "./failure-view";

/** The stored errors behind a failed-reviews callout, for support: a muted Details disclosure, never the main text. */
export function FailureDetails({ groups }: { groups: readonly FailureGroup[] }) {
  const rows = groups.flatMap((g) => g.details);
  if (!rows.length) return null;
  return (
    <details className="mt-1 text-xs text-muted-foreground">
      <summary className="cursor-pointer rounded-sm py-0.5">Details</summary>
      <ul className="mt-0.5 space-y-0.5">
        {rows.slice(0, 10).map((r, i) => (
          <li key={`${r.incident}-${i}`} className="break-words">
            <span className="font-mono">{r.incident}</span>: {r.reason}
          </li>
        ))}
      </ul>
    </details>
  );
}
