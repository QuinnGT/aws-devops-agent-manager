import { redirect } from "next/navigation";
import { can, requireUserOrRedirect } from "@/server/auth/dal";
import { listSpaces } from "@/server/spaces/queries";
import SpacesPage from "./spaces/page";

/**
 * `/` opens the space when the caller can see exactly one; otherwise it is
 * the All spaces page (MASTER "Shell"). All spaces stays at `/spaces`, linked
 * from the sidebar and the space switcher.
 */
export default async function RootPage() {
  const user = await requireUserOrRedirect();
  const visible: string[] = [];
  for (const s of await listSpaces()) {
    if (await can(user, "assets.read", s.id)) visible.push(s.alias);
    if (visible.length > 1) break;
  }
  if (visible.length === 1) redirect(`/spaces/${encodeURIComponent(visible[0]!)}`);
  return <SpacesPage />;
}
