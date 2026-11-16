import { Bot, Brain, Database, FileText, Package, Puzzle, type LucideIcon } from "lucide-react";
import type { ReactNode } from "react";
import { AssetTypeIcon } from "@/components/common/asset-type-icon";
import { PageHeader } from "@/components/common/page-header";
import type { ManagedLabel } from "@/server/assets/catalog";
import { ManagedBadge, TypeBadge } from "./badges";

/** Header icons per asset type (pages/asset-detail.md, "Header"). Other types use the shared AssetTypeIcon. */
const HEADER_ICONS: Record<string, LucideIcon> = {
  agents_md: FileText,
  skill: Puzzle,
  memory_store: Database,
  memory: Brain,
  custom_agent: Bot,
  artifact: Package,
};

/**
 * The asset page header: a 40 px icon box, the name, the type and Managed
 * badges, the status control, the description and one meta line, with the
 * page actions on the right. The draft editor reuses it without `status`.
 */
export function AssetHeader({
  assetType,
  name,
  typeLabel,
  managed,
  status,
  description,
  meta,
  actions,
}: {
  assetType: string;
  name: string;
  typeLabel: string;
  managed: ManagedLabel;
  status?: ReactNode;
  description?: string | null;
  meta: ReactNode[];
  actions?: ReactNode;
}) {
  const Icon = HEADER_ICONS[assetType];
  return (
    <PageHeader
      icon={Icon ? <Icon /> : <AssetTypeIcon assetType={assetType} />}
      title={name}
      badges={
        <>
          <TypeBadge label={typeLabel} />
          <ManagedBadge managed={managed} />
          {status}
        </>
      }
      description={description || undefined}
      meta={meta}
      actions={actions}
    />
  );
}
