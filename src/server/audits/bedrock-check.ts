import { inferenceRegion } from "@/server/ai/bedrock";
import type { AwsErrorKind } from "@/server/ai/error-kind";
import type { ModelCatalog } from "@/server/ai/models";
import type { Actor, SpaceAwsConfig } from "@/server/aws/clients";
import { toAwsConfig, type Space } from "@/server/spaces/queries";

/**
 * Whether the space can reach Amazon Bedrock for an audit, from the model
 * catalogue for its inference Region (src/server/ai/catalog.ts). New audit
 * shows it as a Readiness row and startAudit refuses to start when the app
 * has no credentials for the space, so an audit that can't run is never
 * started. A successful list is cached for a few minutes by the catalogue; a
 * missing profile fails while the credentials are resolved, before any call.
 * Tests and the demo seed pass `list` (src/server/audits/testing.ts, reachableCatalog).
 */

export type ListCatalog = (space: SpaceAwsConfig, actor: Actor, region: string) => Promise<ModelCatalog>;

export interface BedrockCheck {
  region: string;
  /** null when the list was read; "timeout" when it took longer than the check waits */
  kind: AwsErrorKind | "timeout" | null;
  /** The catalogue when it answered in time (also when it failed) */
  catalog: ModelCatalog | null;
}

/** How long a page waits for the list before it shows "can't check" and lets the audit start. */
export const BEDROCK_CHECK_TIMEOUT_MS = 4000;

export async function checkBedrock(space: Space, actor: Actor, deps: { list?: ListCatalog; timeoutMs?: number } = {}): Promise<BedrockCheck> {
  const region = inferenceRegion(space, space.parsedSettings);
  // Loaded on use: the catalogue is server-only, and scripts that pass `list` (the demo seed) never need it.
  const list: ListCatalog = deps.list ?? (async (s, a, r) => (await import("@/server/ai/catalog")).listModels(s, a, r));
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), deps.timeoutMs ?? BEDROCK_CHECK_TIMEOUT_MS);
  });
  try {
    const catalog = await Promise.race([list(toAwsConfig(space), actor, region), timeout]);
    if (!catalog) return { region, kind: "timeout", catalog: null };
    return { region, kind: catalog.error ? (catalog.errorKind ?? "other") : null, catalog };
  } catch {
    return { region, kind: "other", catalog: null };
  } finally {
    clearTimeout(timer);
  }
}

/** Only a missing credential chain stops an audit from starting; a refused list or a slow answer still lets a typed model ID run. */
export const bedrockBlocksStart = (kind: BedrockCheck["kind"]) => kind === "no-credentials";
