import { Bot, CircleQuestionMark, Monitor, Terminal, UserCheck, type LucideIcon } from "lucide-react";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import type { ChangeSource } from "@/lib/assets/types";
import { cn } from "@/lib/utils";
import { getAppPolicy } from "@/server/policy";
import { longSourceLabel, shortSourceLabel } from "./source-labels";

/** Icon and 12% tint per source (design-system MASTER "Change sources"). Literal classes so Tailwind finds them. */
export const SOURCE_STYLE: Record<ChangeSource, { icon: LucideIcon; chip: string; bar: string }> = {
  agent: { icon: Bot, chip: "bg-src-agent/12 text-src-agent", bar: "bg-src-agent" },
  console: { icon: Monitor, chip: "bg-src-console/12 text-src-console", bar: "bg-src-console" },
  cli: { icon: Terminal, chip: "bg-src-cli/12 text-src-cli", bar: "bg-src-cli" },
  app: { icon: UserCheck, chip: "bg-src-app/12 text-src-app", bar: "bg-src-app" },
  unknown: { icon: CircleQuestionMark, chip: "bg-src-unknown/12 text-src-unknown", bar: "bg-src-unknown" },
};

/**
 * Who made a change: icon plus the short policy label on the source's tint
 * (server component; labels come from policy/attribution.yaml). The tooltip
 * shows the long label and the principal (or the source's policy note, for
 * the agent's "no API call" sentence). A provisional attribution has a
 * dashed border and "(checking)" in the tooltip.
 */
export function SourceBadge({
  source,
  principal,
  provisional = false,
  recordedLabel,
  className,
}: {
  source: ChangeSource;
  principal?: string | null;
  provisional?: boolean;
  /** Label stored with the change (asset_changes.change_source_label) */
  recordedLabel?: string | null;
  className?: string;
}) {
  const policy = getAppPolicy().policy.attribution;
  const short = shortSourceLabel(source, policy);
  const long = longSourceLabel(source, policy, recordedLabel);
  const { icon: Icon, chip } = SOURCE_STYLE[source];
  const note = policy.notes[source];
  const who = principal && principal !== long ? principal : null;
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span
          className={cn(
            "inline-flex h-6 w-fit items-center gap-1.5 rounded-md border border-transparent px-2 text-xs font-medium whitespace-nowrap",
            chip,
            provisional && "border-dashed border-current",
            className,
          )}
        >
          <Icon className="size-3.5" aria-hidden />
          {short}
        </span>
      </TooltipTrigger>
      <TooltipContent className="max-w-xs">
        {note ?? (
          <>
            {long}
            {who ? ` · ${who}` : ""}
          </>
        )}
        {provisional ? " (checking)" : ""}
      </TooltipContent>
    </Tooltip>
  );
}
