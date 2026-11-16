import { modelCatalogFor, ModelCatalogError, MODEL_CATALOG_PERMISSIONS } from "@/server/ai/catalog-service";
import { decodeParam } from "@/server/assets/guard";
import { AuthError, requirePermission } from "@/server/auth/dal";
import { actorOf } from "@/server/spaces/actor";
import { getSpaceByAlias } from "@/server/spaces/queries";

const json = (status: number, body: unknown) => Response.json(body, { status, headers: { "Cache-Control": "private, no-store" } });

/** The first of `permissions` the caller has in the space; AuthError when none. */
async function requireAnyPermission(permissions: readonly (typeof MODEL_CATALOG_PERMISSIONS)[number][], spaceId: string) {
  let last: unknown = null;
  for (const p of permissions) {
    try {
      return await requirePermission(p, spaceId);
    } catch (err) {
      if (!(err instanceof AuthError) || err.status === 401) throw err;
      last = err;
    }
  }
  throw last ?? new AuthError(403, "Missing permission");
}

/**
 * The Bedrock models the space's read role can list (ModelCatalog), for the
 * model pickers. `?region=` overrides the space's inference Region. Needs
 * `audits.run` or `spaces.manage` in the space. A failed Bedrock call is a
 * 200 with `error` set, so the picker can fall back to a typed ID.
 */
export async function GET(req: Request, ctx: RouteContext<"/api/spaces/[alias]/models">) {
  try {
    const { alias } = await ctx.params;
    const space = await getSpaceByAlias(decodeParam(alias));
    if (!space) return json(404, { error: "There is no such space." });
    const user = await requireAnyPermission(MODEL_CATALOG_PERMISSIONS, space.id);
    const region = new URL(req.url).searchParams.get("region");
    return json(200, await modelCatalogFor(space, actorOf(user), { region }));
  } catch (err) {
    if (err instanceof AuthError) return json(err.status, { error: err.status === 401 ? "You are signed out. Sign in and try again." : "You can't list models in this space." });
    if (err instanceof ModelCatalogError) return json(400, { error: err.message, field: err.field });
    throw err;
  }
}
