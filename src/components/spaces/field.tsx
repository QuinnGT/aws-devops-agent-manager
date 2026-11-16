import { CircleX } from "lucide-react";
import { Children, cloneElement, isValidElement, type ReactElement, type ReactNode } from "react";
import { Callout } from "@/components/common/callout";
import { Label } from "@/components/ui/label";
import { cn } from "@/lib/utils";

/**
 * A form control with its label above, help text under it and an inline
 * error (role="alert") under that. The one child control gets
 * aria-describedby for the help and error text, and aria-invalid on error.
 */
export function Field({
  id,
  label,
  hint,
  error,
  optional = false,
  children,
  className,
}: {
  id: string;
  label: ReactNode;
  hint?: ReactNode;
  error?: string;
  optional?: boolean;
  children: ReactNode;
  className?: string;
}) {
  const hintId = hint ? `${id}-hint` : undefined;
  const errorId = error ? `${id}-error` : undefined;
  const only = Children.count(children) === 1 ? Children.toArray(children)[0] : null;
  const control =
    only && isValidElement(only)
      ? cloneElement(only as ReactElement<{ "aria-describedby"?: string; "aria-invalid"?: boolean }>, {
          "aria-describedby": [(only.props as { "aria-describedby"?: string })["aria-describedby"], hintId, errorId].filter(Boolean).join(" ") || undefined,
          "aria-invalid": error ? true : undefined,
        })
      : children;
  return (
    <div className={cn("space-y-1.5", className)}>
      <Label htmlFor={id} className="block leading-snug">
        {label}
        {optional ? <span className="font-normal text-muted-foreground"> (optional)</span> : null}
      </Label>
      {control}
      {hint ? (
        <p id={hintId} className="text-xs text-muted-foreground">
          {hint}
        </p>
      ) : null}
      <FieldError id={errorId} error={error} />
    </div>
  );
}

/** An inline field error that says how to fix it. */
export function FieldError({ id, error, className }: { id?: string; error?: string; className?: string }) {
  if (!error) return null;
  return (
    <p id={id} role="alert" className={cn("flex items-start gap-1.5 text-xs font-medium text-destructive-fg", className)}>
      <CircleX className="mt-px size-3.5 shrink-0" aria-hidden />
      {error}
    </p>
  );
}

/** A checkbox (or other inline control) with its label beside it and help text below. */
export function CheckField({
  control,
  id,
  label,
  hint,
  error,
  children,
}: {
  control: ReactNode;
  id: string;
  label: ReactNode;
  hint?: ReactNode;
  error?: string;
  children?: ReactNode;
}) {
  return (
    <div className="space-y-1">
      <div className="flex items-start gap-1.5">
        {control}
        <Label htmlFor={id} className="pt-[3px] leading-snug">
          {label}
        </Label>
      </div>
      {hint ? (
        <p id={`${id}-hint`} className="pl-[30px] text-xs text-muted-foreground">
          {hint}
        </p>
      ) : null}
      <FieldError id={error ? `${id}-error` : undefined} error={error} className="pl-[30px]" />
      {children ? <div className="pl-[30px]">{children}</div> : null}
    </div>
  );
}

/** Classes for a native <select>, matching the shadcn input. */
export const selectClass =
  "h-8 w-full rounded-lg border border-input bg-transparent px-2.5 text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 disabled:opacity-50 aria-invalid:border-destructive dark:bg-input/30 dark:[&>option]:bg-popover";

/** Classes for a native checkbox. */
export const checkboxClass = "size-4 rounded border-input accent-primary";

/**
 * A rejected save: a destructive callout with the server's message (it says
 * what to do next). Confirmations are toasts (useSavedToast), so nothing
 * renders for a successful save.
 */
export function FormMessage({ state }: { state: { ok: boolean; message: string | null; fieldErrors?: Record<string, string> } }) {
  if (!state.message || state.ok) return null;
  // When the message only repeats a field's error, say what to do instead of announcing it twice.
  const repeats = Object.values(state.fieldErrors ?? {}).includes(state.message);
  return <Callout tone="destructive" title={repeats ? "Nothing was saved. Fix the fields marked above, then save again." : state.message} afterAction />;
}
