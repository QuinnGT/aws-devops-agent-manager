import { ChangeChip } from "@/components/common/change-chip";
import { SourceBadge } from "@/components/common/source-badge";
import type { ChangeWord } from "@/components/common/status-words";
import { Time } from "@/components/common/time";
import { VersionBadge } from "@/components/common/version-badge";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import type { LastChange, MetadataKeyChange, ReleaseChange } from "@/server/releases";

/** Table cells shared by the release detail and the rollback preview (server components). */

/** "ACTIVE" reads "Active"; other values are shown with only the first letter capitalized. */
export function statusWord(status: string | null | undefined): string | null {
  if (!status) return null;
  const lower = status.toLowerCase().replace(/_/g, " ");
  return lower.charAt(0).toUpperCase() + lower.slice(1);
}

/** Change words of the release detail (pages/releases.md "Change words"), on the shared ChangeChip words. */
const RELEASE_CHANGE_WORDS: Record<ReleaseChange, { word: ChangeWord; label: string }> = {
  removed: { word: "removed", label: "Deleted" },
  added: { word: "added", label: "Added since" },
  content: { word: "update-content", label: "Content changed" },
  status: { word: "set-active", label: "Status changed" },
  metadata: { word: "metadata-only", label: "Metadata changed" },
  unchanged: { word: "unchanged", label: "Same" },
};

export function ReleaseChangeChip({ change }: { change: ReleaseChange }) {
  const w = RELEASE_CHANGE_WORDS[change];
  return <ChangeChip word={w.word} label={w.label} />;
}

/** Version badge and status word on one line. */
export function VersionStatus({ version, status }: { version: number | "new" | "deleted" | null; status?: string | null }) {
  const word = statusWord(status);
  return (
    <span className="inline-flex items-center gap-1.5 whitespace-nowrap">
      {version !== null ? <VersionBadge version={version} /> : null}
      {word ? <span>{word}</span> : null}
    </span>
  );
}

/** "sha 9c2e41a" with the full hash in a tooltip that also opens on keyboard focus. */
export function ShortHash({ hash }: { hash: string }) {
  if (!hash) return null;
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button type="button" className="inline-flex min-h-6 items-center rounded-sm font-mono text-xs text-muted-foreground">
          <span className="sr-only">Content hash </span>
          sha {hash.slice(0, 7)}
        </button>
      </TooltipTrigger>
      <TooltipContent className="font-mono">{hash}</TooltipContent>
    </Tooltip>
  );
}

export function metadataChangeText(changes: readonly MetadataKeyChange[], max = 2): string | null {
  if (!changes.length) return null;
  const shown = changes.slice(0, max).map((c) => (c.change === "added" ? `Key added: ${c.key}` : c.change === "removed" ? `Key removed: ${c.key}` : `${c.key} changed`));
  const rest = changes.length - shown.length;
  return `${shown.join(", ")}${rest > 0 ? ` and ${rest} more` : ""}`;
}

/** Source and time of the newest change since the release. */
export function LastChangeCell({ change }: { change: LastChange | null }) {
  if (!change) return null;
  return (
    <div className="flex flex-col items-start gap-0.5">
      <SourceBadge source={change.source} principal={change.principal} provisional={change.provisional} recordedLabel={change.label} />
      <span className="text-xs text-muted-foreground">
        <Time value={change.at} format="datetime" />
      </span>
    </div>
  );
}
