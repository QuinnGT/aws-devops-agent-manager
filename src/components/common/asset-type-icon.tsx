import { Brain, Database, File, FileText, FlaskConical, MessageSquareText, Package, Paperclip, UserCog, Wrench, type LucideIcon } from "lucide-react";
import { cn } from "@/lib/utils";

const ICONS: Record<string, LucideIcon> = {
  agents_md: FileText,
  skill: Wrench,
  memory_store: Database,
  memory: Brain,
  custom_agent: UserCog,
  artifact: Package,
  attachment: Paperclip,
  test_profile: FlaskConical,
  feedback: MessageSquareText,
};

/** Decorative icon for an asset type; unknown types get a plain file icon. */
export function AssetTypeIcon({ assetType, className }: { assetType: string; className?: string }) {
  const Icon = ICONS[assetType] ?? File;
  return <Icon className={cn("size-4 shrink-0 text-muted-foreground", className)} aria-hidden />;
}
