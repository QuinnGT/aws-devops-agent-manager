import { Upload } from "lucide-react";
import Link from "next/link";
import { LinkTabs } from "@/components/common/link-tabs";
import { PageHeader } from "@/components/common/page-header";
import { buttonVariants } from "@/components/ui/button";
import { spaceBase } from "@/components/app-shell/nav";

export const PLANS_DESCRIPTION = "Drafts are edits saved in this app. A plan checks them against the live space, and nothing is written until the plan is applied.";

/**
 * The header shared by the Plans and Drafts pages (pages/plans.md,
 * pages/drafts.md): title, description, "Import package" for plans.create,
 * and the Plans and Drafts tabs with their open counts.
 */
export function PlansHeader({ alias, current, openPlans, openDrafts, canImport }: { alias: string; current: "plans" | "drafts"; openPlans: number; openDrafts: number; canImport: boolean }) {
  const base = spaceBase(alias);
  return (
    <div className="space-y-4">
      <PageHeader
        title="Plans"
        description={PLANS_DESCRIPTION}
        actions={
          canImport ? (
            <Link href={`${base}/plans/import`} className={buttonVariants({ variant: "outline", size: "sm" })}>
              <Upload aria-hidden />
              Import package
            </Link>
          ) : null
        }
      />
      <LinkTabs
        label="Plans and drafts"
        current={current}
        items={[
          { key: "plans", href: `${base}/plans`, label: "Plans", count: openPlans },
          { key: "drafts", href: `${base}/drafts`, label: "Drafts", count: openDrafts },
        ]}
      />
    </div>
  );
}
