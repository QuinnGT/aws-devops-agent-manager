import { authErrorResponse, requirePermission } from "@/server/auth/dal";
import { URL_ASSET_ID, URL_COMMIT } from "@/server/assets/config";
import { decodeParam } from "@/server/assets/guard";
import { getIndexedAsset } from "@/server/assets/queries";
import { listAssetCommits, openSpaceHistoryRepo, readCommittedFile } from "@/server/assets/repo";
import { getSpaceByAlias } from "@/server/spaces/queries";

const notFound = () => Response.json({ error: "Not found" }, { status: 404 });

/**
 * Download one committed file of an asset from the history repository, at
 * HEAD or at one of the asset's own commits. Always an attachment served as
 * text with nosniff, so a browser never renders asset content from this URL.
 */
export async function GET(req: Request, ctx: RouteContext<"/api/spaces/[alias]/assets/[assetId]/file">) {
  try {
    const { alias, assetId: rawId } = await ctx.params;
    const space = await getSpaceByAlias(decodeParam(alias));
    if (!space) return notFound();
    await requirePermission("assets.read", space.id);

    const assetId = decodeParam(rawId);
    const url = new URL(req.url);
    const filePath = url.searchParams.get("path") ?? "";
    const commit = url.searchParams.get("commit") ?? "HEAD";
    if (!URL_ASSET_ID.test(assetId) || !filePath || filePath.length > 1024 || (commit !== "HEAD" && !URL_COMMIT.test(commit))) return notFound();

    const asset = await getIndexedAsset(space.id, assetId);
    if (!asset?.gitPath) return notFound();
    const repo = await openSpaceHistoryRepo(space);
    if (!repo.ok) return notFound();
    if (commit !== "HEAD") {
      const commits = await listAssetCommits(repo.repo, asset.gitPath, asset.assetId);
      if (!commits.some((c) => c.hash === commit)) return notFound();
    }
    const file = await readCommittedFile(repo.repo, asset.gitPath, repo.layout, filePath, commit);
    if (!file) return notFound();

    const name = (filePath.split("/").pop() ?? "file").replace(/[^\w.-]+/g, "_").slice(0, 120) || "file";
    return new Response(file.content, {
      headers: {
        "Content-Type": "text/plain; charset=utf-8",
        "Content-Disposition": `attachment; filename="${name}"`,
        "X-Content-Type-Options": "nosniff",
        "Cache-Control": "private, no-store",
      },
    });
  } catch (err) {
    const r = authErrorResponse(err);
    if (r) return r;
    throw err;
  }
}
