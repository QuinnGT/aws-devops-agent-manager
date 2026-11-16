import { z } from "zod";
import type { ConnectionDetail } from "./connection-test";

/** Read agent_spaces.connection_detail for display, dropping anything unexpected. */
const detailSchema = z
  .object({
    assetTypeIds: z.array(z.string()).optional(),
    counts: z.object({ assetTypes: z.number(), sampledAssets: z.number(), moreAssets: z.boolean() }).optional(),
    externalIdCheck: z.enum(["skipped", "enforced", "not-enforced", "error"]).optional(),
    failedStep: z.enum(["GetAgentSpace", "ListAssetTypes", "ListAssets", "ExternalIdCheck"]).optional(),
    error: z.object({ name: z.string(), message: z.string() }).optional(),
  })
  .catch({});

export function parseConnectionDetail(raw: unknown): ConnectionDetail {
  return detailSchema.parse(raw ?? {});
}
