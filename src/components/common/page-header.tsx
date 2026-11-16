import { Fragment, type ReactNode } from "react";
import { cn } from "@/lib/utils";

/**
 * The page's one h1, plus one muted meta line joined by " · ". Actions sit at
 * the right and wrap below on narrow screens.
 */
export function PageHeader({
  title,
  description,
  meta,
  badges,
  actions,
  icon,
  className,
  actionsClassName,
}: {
  title: ReactNode;
  description?: ReactNode;
  meta?: ReactNode[];
  badges?: ReactNode;
  actions?: ReactNode;
  icon?: ReactNode;
  className?: string;
  /** Classes for the actions wrapper, for example "shrink-0" to keep wide actions on the title's row */
  actionsClassName?: string;
}) {
  const items = (meta ?? []).filter((m) => m !== null && m !== undefined && m !== false && m !== "");
  return (
    <div className={cn("flex flex-wrap items-start justify-between gap-x-4 gap-y-3", className)}>
      <div className="flex min-w-0 items-start gap-3">
        {icon ? (
          <div className="grid size-10 shrink-0 place-items-center rounded-lg bg-muted text-muted-foreground [&_svg]:size-5" aria-hidden>
            {icon}
          </div>
        ) : null}
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <h1 className="text-[22px] leading-tight font-semibold tracking-tight break-words">{title}</h1>
            {badges}
          </div>
          {description ? <p className="mt-1 max-w-[72ch] text-sm text-muted-foreground">{description}</p> : null}
          {items.length ? (
            <p className="mt-0.5 text-[13px] text-muted-foreground">
              {items.map((m, i) => (
                <Fragment key={i}>
                  {i > 0 ? " · " : null}
                  {m}
                </Fragment>
              ))}
            </p>
          ) : null}
        </div>
      </div>
      {actions ? <div className={cn("flex flex-wrap items-center gap-2", actionsClassName)}>{actions}</div> : null}
    </div>
  );
}
