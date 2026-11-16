import { redirect } from "next/navigation";
import { diffHref, historyHref } from "@/components/assets/format";
import { URL_COMMIT } from "@/server/assets/config";
import { assetIdParam, firstParam, loadSpaceForPage } from "@/server/assets/guard";

/** The old diff page moved to the compare view of the Versions tab, with the same commits as `from` and `to`. */
export default async function AssetDiffRedirect(props: PageProps<"/spaces/[alias]/history/[assetId]/diff">) {
  const { alias, assetId: rawId } = await props.params;
  const sp = await props.searchParams;
  const { space } = await loadSpaceForPage(alias, "history.read");
  const assetId = assetIdParam(rawId);
  const from = firstParam(sp.from) ?? "";
  const to = firstParam(sp.to) ?? "";
  redirect(URL_COMMIT.test(from) && URL_COMMIT.test(to) ? diffHref(space.alias, assetId, from, to) : historyHref(space.alias, assetId));
}
