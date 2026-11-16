import "server-only";
import { Download, Upload } from "lucide-react";
import Link from "next/link";
import { notFound } from "next/navigation";
import type { ReactNode } from "react";
import { SpaceTopBar } from "@/components/app-shell/space-top-bar";
import type { Crumb } from "@/components/app-shell/top-bar";
import { EmptyState } from "@/components/common/empty-state";
import { LinkTabs } from "@/components/common/link-tabs";
import { PageHeader } from "@/components/common/page-header";
import { buttonVariants } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { can, requireUserOrRedirect, type AppUser } from "@/server/auth/dal";
import { journalCounts } from "@/server/journals/queries";
import { getSpaceByAlias, type Space } from "@/server/spaces/queries";

/** Helpers shared by the journals and analysis pages. Every journals page calls loadSpaceForPage first. */

export async function loadSpaceForPage(alias: string) {
  const user = await requireUserOrRedirect();
  let space = await getSpaceByAlias(alias);
  if (!space && alias.includes("%")) {
    try {
      space = await getSpaceByAlias(decodeURIComponent(alias));
    } catch {
      space = null;
    }
  }
  if (!space) notFound();
  const [read, exp, imp, audits] = await Promise.all([
    can(user, "journals.read", space.id),
    can(user, "journals.export", space.id),
    can(user, "journals.import", space.id),
    can(user, "audits.read", space.id),
  ]);
  return {
    user,
    space,
    perms: { read, export: exp, import: imp, audits },
    base: `/spaces/${encodeURIComponent(space.alias)}/journals`,
  };
}

export const outlineSm = buttonVariants({ variant: "outline", size: "sm" });
export const primarySm = buttonVariants({ variant: "default", size: "sm" });
export const ghostSm = buttonVariants({ variant: "ghost", size: "sm" });

/** Table cell classes matching the option A tables: muted header row, 13 px cells, right-aligned numbers. */
export const TH = "h-auto bg-muted px-3 py-2 text-xs font-medium text-muted-foreground";
export const TH_NUM = `${TH} text-right`;
export const TD = "px-3 py-2 align-top text-[13px] whitespace-normal";
export const TD_NUM = `${TD} text-right tabular-nums`;
/** The row's name link: 24 px target, underline on hover. */
export const ROW_LINK = "inline-flex min-h-6 items-center rounded-sm font-semibold underline-offset-4 hover:underline";

type Tab = "investigations" | "exports" | "imports";

/** Top bar, page header and the Investigations, Exports and Imports tabs. */
export async function JournalsHeader({
  space,
  user,
  base,
  active,
  perms,
}: {
  space: Space;
  user: AppUser;
  base: string;
  active: Tab;
  perms: { read: boolean; export: boolean; import: boolean };
}) {
  const tabLabel = { investigations: "Investigations", exports: "Exports", imports: "Imports" }[active];
  const crumbs: Crumb[] = active === "investigations" ? [{ label: "Journals" }] : [{ label: "Journals", href: base }, { label: tabLabel }];
  const counts = perms.read ? await journalCounts(space.id) : null;
  const actions =
    active === "investigations" && perms.read ? (
      <>
        {perms.import ? (
          <Link className={outlineSm} href={`${base}/imports`}>
            <Upload aria-hidden />
            Import journals
          </Link>
        ) : null}
        {perms.export ? (
          <Link className={primarySm} href={`${base}/exports`}>
            <Download aria-hidden />
            Export journals
          </Link>
        ) : null}
      </>
    ) : undefined;
  return (
    <>
      <SpaceTopBar space={space} user={user} crumbs={crumbs} />
      <PageHeader
        title="Journals"
        description="Investigations cached from this space or imported from files. Exports read the space with its read role and build one zip."
        actions={actions}
      />
      {counts ? (
        <LinkTabs
          label="Journals sections"
          current={active}
          items={[
            { key: "investigations", href: base, label: "Investigations", count: counts.investigations },
            { key: "exports", href: `${base}/exports`, label: "Exports", count: counts.exports },
            { key: "imports", href: `${base}/imports`, label: "Imports", count: counts.imports },
          ]}
        />
      ) : null}
    </>
  );
}

export function NoAccess({ what = "journals" }: { what?: string }) {
  return (
    <Card className="py-0">
      <EmptyState title={`You can't view ${what} in this space`}>{`Your role in this space doesn't include reading ${what}. An Admin can change role bindings.`}</EmptyState>
    </Card>
  );
}

/** The first value of each search parameter. */
export function firstParams(sp: Record<string, string | string[] | undefined>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(sp)) {
    const s = Array.isArray(v) ? v[0] : v;
    if (typeof s === "string") out[k] = s;
  }
  return out;
}

export function hrefWith(base: string, params: Record<string, string | number | null | undefined>): string {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null && v !== "") q.set(k, String(v));
  const s = q.toString();
  return s ? `${base}?${s}` : base;
}

/** Card footer with "Showing 1 to 50 of 120" and links to the neighboring pages. Nothing when everything fits on one page. */
export function Pager({ page, pageSize, total, hrefFor, noun }: { page: number; pageSize: number; total: number; hrefFor: (page: number) => string; noun: string }) {
  const pages = Math.max(1, Math.ceil(total / pageSize));
  if (pages <= 1) return null;
  const current = Math.min(page, pages);
  const start = (current - 1) * pageSize + 1;
  const end = Math.min(total, current * pageSize);
  return (
    <nav aria-label="Pages" className="flex flex-wrap items-center justify-between gap-2 border-t px-4 py-2 text-xs text-muted-foreground">
      <span className="tabular-nums">
        Showing {start} to {end} of {total} {noun}
      </span>
      <span className="flex items-center gap-2">
        {current > 1 ? (
          <Link className={outlineSm} href={hrefFor(current - 1)}>
            Previous page
          </Link>
        ) : null}
        <span className="tabular-nums">
          Page {current} of {pages}
        </span>
        {current < pages ? (
          <Link className={outlineSm} href={hrefFor(current + 1)}>
            Next page
          </Link>
        ) : null}
      </span>
    </nav>
  );
}

/** A label and value row in a details card. */
export function Detail({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="grid grid-cols-[7.5rem_minmax(0,1fr)] gap-x-3 px-4 py-1.5 text-[13px]">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="min-w-0 break-words">{children}</dd>
    </div>
  );
}
