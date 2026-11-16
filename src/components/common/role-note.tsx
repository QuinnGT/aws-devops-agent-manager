import { UserLock } from "lucide-react";
import Link from "next/link";
import { cn } from "@/lib/utils";

/**
 * One muted line that says why controls are missing for the caller's role.
 * Pass the text from `roleNote()` in `src/server/auth/role-words.ts`; renders
 * nothing when it is null. With `alias`, it ends with a link to the space's
 * "Who can do what" page, so the reader can find the people who hold a role.
 */
export function RoleNote({ text, alias, className }: { text: string | null; alias?: string; className?: string }) {
  if (!text) return null;
  return (
    <p className={cn("flex flex-wrap items-center gap-x-1.5 gap-y-0.5 text-xs text-muted-foreground", className)}>
      <UserLock className="size-3.5 shrink-0" aria-hidden />
      <span>{text}</span>
      {alias ? (
        <Link className="font-medium underline underline-offset-4 hover:text-foreground" href={`/spaces/${encodeURIComponent(alias)}/roles`}>
          See who has each role
        </Link>
      ) : null}
    </p>
  );
}
