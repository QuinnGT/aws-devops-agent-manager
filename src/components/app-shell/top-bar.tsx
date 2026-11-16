import Link from "next/link";
import { Fragment, type ReactNode } from "react";
import { Breadcrumb, BreadcrumbItem, BreadcrumbLink, BreadcrumbList, BreadcrumbPage, BreadcrumbSeparator } from "@/components/ui/breadcrumb";
import { Separator } from "@/components/ui/separator";
import { SidebarTrigger } from "@/components/ui/sidebar";
import { cn } from "@/lib/utils";

export interface Crumb {
  label: string;
  href?: string;
}

/**
 * The 52 px bar above every page: sidebar toggle, breadcrumbs (the last one is
 * the current page) and space-wide controls on the right. It is fixed to the
 * top of the viewport beside the sidebar, so a page can render it from inside
 * any wrapper. Page actions belong in the page header, not here.
 */
export function TopBar({
  crumbs,
  right,
  fallback = false,
  keepLastTwoBelow = "sm",
}: {
  crumbs: Crumb[];
  right?: ReactNode;
  fallback?: boolean;
  /** Width below which only the last two crumbs stay: 640 px (sm) by default, 1024 px (lg) for long trails such as the asset page */
  keepLastTwoBelow?: "sm" | "lg";
}) {
  const show = keepLastTwoBelow === "lg" ? "hidden lg:inline-flex" : "hidden sm:inline-flex";
  return (
    <header
      data-top-bar={fallback ? "fallback" : "page"}
      className={cn(
        "fixed inset-x-0 top-0 z-20 flex h-13 items-center justify-between gap-3 border-b bg-background pr-4 pl-2.5",
        "transition-[left] duration-200 ease-linear md:left-(--sidebar-width) md:[.peer[data-state=collapsed]~*_&]:left-0",
        // The layout's fallback bar keeps the sidebar toggle on pages that render no TopBar; a page's own bar hides it.
        fallback && "group-has-[[data-top-bar=page]]/sidebar-wrapper:hidden",
      )}
    >
      <div className="flex min-w-0 items-center gap-1.5">
        <SidebarTrigger className="size-8" />
        <Separator orientation="vertical" className="mx-1 data-[orientation=vertical]:h-4.5" />
        <Breadcrumb aria-label="Breadcrumb" className="min-w-0">
          <BreadcrumbList className="flex-nowrap gap-1.5 overflow-hidden text-[13px] whitespace-nowrap">
            {crumbs.map((c, i) => {
              const last = i === crumbs.length - 1;
              // Below 640 px (or 1024 px) only the last two crumbs stay.
              const narrowHidden = i < crumbs.length - 2 ? show : "";
              return (
                <Fragment key={`${i}:${c.label}`}>
                  {i > 0 ? <BreadcrumbSeparator className={cn(i < crumbs.length - 1 && show)} /> : null}
                  <BreadcrumbItem className={cn(last ? "shrink-0" : "min-w-0", narrowHidden)}>
                    {last || !c.href ? (
                      <BreadcrumbPage className={cn("block truncate leading-6", last ? "font-semibold" : "text-muted-foreground")} aria-current={last ? "page" : undefined}>
                        {c.label}
                      </BreadcrumbPage>
                    ) : (
                      <BreadcrumbLink asChild className="block max-w-64 truncate rounded-md px-0.5 leading-6">
                        <Link href={c.href}>{c.label}</Link>
                      </BreadcrumbLink>
                    )}
                  </BreadcrumbItem>
                </Fragment>
              );
            })}
          </BreadcrumbList>
        </Breadcrumb>
      </div>
      {right ? <div className="flex shrink-0 items-center gap-2">{right}</div> : null}
    </header>
  );
}
