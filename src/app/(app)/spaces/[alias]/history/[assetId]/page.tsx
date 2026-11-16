import { redirect } from "next/navigation";
import { historyHref } from "@/components/assets/format";
import { assetIdParam, loadSpaceForPage } from "@/server/assets/guard";

/** The old asset history page moved to the Versions tab of the asset page (pages/asset-detail.md, "Routes"). */
export default async function AssetHistoryRedirect(props: PageProps<"/spaces/[alias]/history/[assetId]">) {
  const { alias, assetId: rawId } = await props.params;
  const { space } = await loadSpaceForPage(alias, "history.read");
  redirect(historyHref(space.alias, assetIdParam(rawId)));
}
