import { GetAssetCommand, ListAssetTypesCommand, ListAssetVersionsCommand, type DevOpsAgentClient } from "@aws-sdk/client-devops-agent";
import { devOpsAgentClient, type Actor } from "@/server/aws/clients";
import { pages } from "@/server/aws/paginate";
import { toAwsConfig, type SpaceRow } from "@/server/spaces/queries";
import type { LiveAssetType } from "./catalog";
import { ASSET_BROWSER } from "./config";
import type { LiveVersion } from "./history";
import type { LiveRead } from "./sync-status";
import { liveErrorMessage } from "@/server/jobs/error-text";

/**
 * Live reads from the Agent Space for the asset browser, always through the
 * space's read role. Every function returns a result instead of throwing, so
 * a page still renders from git and Postgres when the API is unreachable.
 */

export interface LiveDeps {
  client: Pick<DevOpsAgentClient, "send">;
  agentSpaceId: string;
  /** Cache key for per-space caches */
  spaceId: string;
}

export function liveDepsForSpace(space: SpaceRow, actor: Actor): LiveDeps {
  return { client: devOpsAgentClient(toAwsConfig(space), "read", actor), agentSpaceId: space.agentSpaceId, spaceId: space.id };
}

export type Result<T> = { ok: true; value: T } | { ok: false; error: string; notFound: boolean };

/**
 * Error wording for live reads, syncs and connection tests is shared with
 * jobs and pages: it lives in `src/server/jobs/error-text.ts` and is
 * re-exported here for the callers that import it from this module.
 */
export { connectionNextStep, liveErrorMessage, liveErrorNeedsSettings } from "@/server/jobs/error-text";

function isNotFound(err: unknown): boolean {
  return err instanceof Error && (err.name === "ResourceNotFoundException" || err.name === "NotFoundException");
}

async function attempt<T>(fn: () => Promise<T>): Promise<Result<T>> {
  try {
    return { ok: true, value: await fn() };
  } catch (err) {
    return { ok: false, error: liveErrorMessage(err), notFound: isNotFound(err) };
  }
}

function iso(d: Date | string | undefined): string {
  if (d === undefined) return "";
  return d instanceof Date ? d.toISOString() : new Date(d).toISOString();
}

const typeCache = new Map<string, { at: number; types: LiveAssetType[] }>();

/** ListAssetTypes, reused per space for ASSET_BROWSER.assetTypesCacheSeconds. */
export async function liveAssetTypes(deps: LiveDeps, now: number = Date.now()): Promise<Result<LiveAssetType[]>> {
  const hit = typeCache.get(deps.spaceId);
  if (hit && now - hit.at < ASSET_BROWSER.assetTypesCacheSeconds * 1000) return { ok: true, value: hit.types };
  const r = await attempt(async () => {
    const out: LiveAssetType[] = [];
    for await (const page of pages((req: { nextToken?: string }) => deps.client.send(new ListAssetTypesCommand(req)), {}, { maxPages: 10 })) {
      for (const t of page.items ?? []) if (t.assetType) out.push({ assetType: t.assetType, description: t.description ?? null });
    }
    return out;
  });
  if (r.ok) typeCache.set(deps.spaceId, { at: now, types: r.value });
  return r;
}

export function resetLiveCachesForTests(): void {
  typeCache.clear();
}

/** GetAsset (current version) as a LiveRead for compareCommittedToLive. */
export async function liveGetAsset(deps: LiveDeps, assetId: string): Promise<LiveRead> {
  const r = await attempt(() => deps.client.send(new GetAssetCommand({ agentSpaceId: deps.agentSpaceId, assetId })));
  if (!r.ok) return { ok: false, notFound: r.notFound, error: r.error };
  const a = r.value.asset;
  if (!a || a.version === undefined) return { ok: false, notFound: true, error: "GetAsset returned no asset" };
  return {
    ok: true,
    asset: {
      version: a.version,
      updatedAt: iso(a.updatedAt),
      metadata: (a.metadata && typeof a.metadata === "object" && !Array.isArray(a.metadata) ? a.metadata : {}) as Record<string, unknown>,
    },
  };
}

/** Every version ListAssetVersions reports, newest first, capped at ASSET_BROWSER.maxLiveVersions. */
export async function liveAssetVersions(deps: LiveDeps, assetId: string): Promise<Result<LiveVersion[]>> {
  return attempt(async () => {
    const out: LiveVersion[] = [];
    const call = (req: { nextToken?: string }) =>
      deps.client.send(new ListAssetVersionsCommand({ agentSpaceId: deps.agentSpaceId, assetId, maxResults: 50, ...req }));
    for await (const page of pages(call, {}, { maxPages: Math.ceil(ASSET_BROWSER.maxLiveVersions / 50) })) {
      for (const v of page.items ?? []) {
        if (v.version !== undefined) out.push({ version: v.version, createdAt: iso(v.createdAt), updatedAt: iso(v.updatedAt) });
      }
    }
    return out.sort((a, b) => b.version - a.version);
  });
}
