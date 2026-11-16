import { cn } from "@/lib/utils";
import { CHANGE_WORDS, type ChangeTone, type ChangeWord } from "./status-words";

const TONE: Record<ChangeTone, string> = {
  info: "text-info-fg",
  agent: "text-src-agent",
  warning: "text-warning-fg",
  muted: "text-muted-foreground",
  success: "text-success-fg",
  destructive: "text-destructive-fg",
};

/**
 * What a plan item, drift row or import row does: icon plus text in the
 * word's tone (no fill). `label` replaces the default text, for example
 * "Update v5 to v6" or "Live is v2", keeping the word's tone and icon.
 */
export function ChangeChip({ word, label, className }: { word: ChangeWord; label?: string; className?: string }) {
  const w = CHANGE_WORDS[word];
  const Icon = w.icon;
  return (
    <span className={cn("inline-flex items-center gap-1.5 text-[13px] font-medium whitespace-nowrap", TONE[w.tone], className)}>
      <Icon className="size-3.5 shrink-0" aria-hidden />
      {label ?? w.label}
    </span>
  );
}
