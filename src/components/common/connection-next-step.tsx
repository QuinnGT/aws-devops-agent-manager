import Link from "next/link";
import { connectionNextStep } from "@/server/assets/live";

/**
 * `connectionNextStep()` for the caller, with one part as a link: "Space
 * settings" for Admins, and "an Admin" for everyone else, pointing at the
 * space's "Who can do what" page so they can find one. Show it once, after
 * the cause, wherever a connection failure that an Admin fixes in Space
 * settings is shown.
 */
export function ConnectionNextStep({ alias, canManage, onSettingsPage = false }: { alias: string; canManage: boolean; onSettingsPage?: boolean }) {
  const text = connectionNextStep({ canManage, onSettingsPage });
  const base = `/spaces/${encodeURIComponent(alias)}`;
  const [words, href] = canManage ? ["Space settings", `${base}/settings`] : ["an Admin", `${base}/roles`];
  const i = canManage && onSettingsPage ? -1 : text.indexOf(words);
  if (i < 0) return <>{text}</>;
  return (
    <>
      {text.slice(0, i)}
      <Link className="font-medium underline underline-offset-4" href={href}>
        {words}
      </Link>
      {text.slice(i + words.length)}
    </>
  );
}
