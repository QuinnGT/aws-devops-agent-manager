import { z } from "zod";
import type { Actor } from "@/server/aws/clients";
import { toAwsConfig, type Space } from "@/server/spaces/queries";
import { regionSchema } from "@/server/spaces/validators";
import { inferenceRegion } from "./bedrock";
import { listModels, type CatalogDeps } from "./catalog";
import type { ModelCatalog } from "./models";

/**
 * GET /api/spaces/<alias>/models calls this
 * after it looked the space up by alias and checked `audits.run` or
 * `spaces.manage` there (MODEL_CATALOG_PERMISSIONS).
 */

/** Either one lets a person see the model list: Editors pick a model for an audit, Admins set the space default. */
export const MODEL_CATALOG_PERMISSIONS = ["audits.run", "spaces.manage"] as const;

export class ModelCatalogError extends Error {
  constructor(
    message: string,
    readonly field: "region",
  ) {
    super(message);
    this.name = "ModelCatalogError";
  }
}

const query = z.object({ region: z.union([z.literal(""), regionSchema]).nullish() });

/**
 * The model list for one space. `region` from the query string wins; without
 * it the inference Region (Space settings, else the space Region) is used.
 */
export async function modelCatalogFor(space: Space, actor: Actor, request: { region?: string | null }, deps: CatalogDeps = {}): Promise<ModelCatalog> {
  const parsed = query.safeParse(request);
  if (!parsed.success) throw new ModelCatalogError("Enter a Region code such as us-west-2.", "region");
  const region = parsed.data.region || inferenceRegion(space, space.parsedSettings);
  return listModels(toAwsConfig(space), actor, region, deps);
}
