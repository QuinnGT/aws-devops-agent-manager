import "server-only";
import {
  BedrockClient,
  ListFoundationModelsCommand,
  ListInferenceProfilesCommand,
  type FoundationModelSummary,
  type InferenceProfileSummary,
} from "@aws-sdk/client-bedrock";
import { spaceCredentials, type Actor, type SpaceAwsConfig } from "@/server/aws/clients";
import { pages } from "@/server/aws/paginate";
import { getAppPolicy } from "@/server/policy";
import { accessDeniedText, awsErrorKind, errorDetail, NO_CREDENTIALS_SENTENCE, type AwsErrorKind } from "./error-kind";
import type { ModelCatalog, ModelOption } from "./models";

/**
 * The model list for the pickers
 * (src/components/common/model-picker.tsx): the system-defined inference
 * profiles and the text foundation models the space's read role can see in
 * one Region. Read-only; nothing here invokes a model.
 *
 * A model that Bedrock only serves through an inference profile is listed
 * through its profiles; a model with on-demand throughput is listed as
 * itself too. A failure becomes a plain `error` sentence, an `errorKind`
 * (src/server/ai/error-kind.ts) and an `errorDetail` naming the refused IAM
 * actions, and the picker falls back to a typed ID.
 */

/** Implementation caps for the catalogue (not policy rules). */
export const CATALOG = {
  /** How long one space and Region's list is reused */
  ttlMs: 5 * 60 * 1000,
  /** ListInferenceProfiles page size and page cap */
  pageSize: 1000,
  maxPages: 10,
} as const;

/** IAM actions the read role needs, shown in Space settings next to the model fields. */
export const MODEL_IAM = {
  list: ["bedrock:ListInferenceProfiles", "bedrock:ListFoundationModels"],
  invoke: ["bedrock:InvokeModel", "bedrock:InvokeModelWithResponseStream"],
} as const;

type Send = Pick<BedrockClient, "send">;

export interface CatalogDeps {
  /** Defaults to a BedrockClient on the space's read role in `region` */
  client?: Send;
  now?: () => number;
}

const cache = new Map<string, { at: number; catalog: ModelCatalog }>();

/** The list is per role, not per user: the key leaves the actor out. */
function cacheKey(space: SpaceAwsConfig, region: string): string {
  return [space.id, region, space.readRoleArn ?? "", space.awsProfile ?? "", space.externalId ?? ""].join("|");
}

export function resetModelCatalogCache(): void {
  cache.clear();
}

function bedrockClient(space: SpaceAwsConfig, actor: Actor, region: string): BedrockClient {
  return new BedrockClient({
    region,
    credentials: spaceCredentials(space, "read", actor),
    retryMode: "adaptive",
    maxAttempts: getAppPolicy().policy.api.maxAttempts,
  });
}

/** The model ID in a foundation model ARN (arn:aws:bedrock:<region>::foundation-model/<id>). */
export function modelIdFromArn(arn: string | undefined): string | null {
  if (!arn) return null;
  const i = arn.indexOf("foundation-model/");
  return i >= 0 ? arn.slice(i + "foundation-model/".length) || null : null;
}

/**
 * A failed list call as a plain sentence (ending with what to do), its kind,
 * and a Details line. `actions` are the IAM actions of the calls that failed;
 * they go in the Details line, never in the sentence.
 */
export function catalogFailure(err: unknown, actions: readonly string[]): { message: string; kind: AwsErrorKind; detail: string } {
  const kind = awsErrorKind(err);
  const detail = kind === "access-denied" && actions.length ? `IAM ${actions.length === 1 ? "action" : "actions"} refused: ${actions.join(", ")}` : errorDetail(err);
  return { message: catalogErrorMessage(err), kind, detail };
}

/** One plain sentence for a failed list call, ending with what to do. */
export function catalogErrorMessage(err: unknown): string {
  switch (awsErrorKind(err)) {
    case "access-denied":
      return `${accessDeniedText("list Bedrock models")} A typed model ID is used as is.`;
    case "no-credentials":
      return `${NO_CREDENTIALS_SENTENCE} You can still type a model ID.`;
    case "expired":
      return "The AWS credentials for this space have expired, so the model list can't be read. Refresh them and open the list again, or type a model ID.";
    case "throttled":
      return "Bedrock is limiting requests right now. Open the list again in a minute, or type a model ID.";
    case "network":
      return "Bedrock can't be reached right now. Open the list again in a minute, or type a model ID.";
    default:
      return "The model list could not be read from Bedrock. Type a model ID.";
  }
}

/** The provider as Bedrock names it, else the first segment of the model ID ("anthropic"). */
function providerOf(modelId: string | null, byModel: ReadonlyMap<string, FoundationModelSummary>): string | null {
  if (!modelId) return null;
  const known = byModel.get(modelId)?.providerName;
  if (known) return known;
  const first = modelId.split(".")[0];
  return first ? first.charAt(0).toUpperCase() + first.slice(1) : null;
}

const canGenerateText = (m: FoundationModelSummary) => (m.outputModalities ?? []).includes("TEXT");
const onDemand = (m: FoundationModelSummary) => (m.inferenceTypesSupported ?? []).includes("ON_DEMAND");

/**
 * The options for a picker, from the two list responses. Pure.
 * - Foundation models: text output and on-demand throughput.
 * - Inference profiles: every profile whose models produce text. When the
 *   foundation list is unavailable (`textModels` null), profiles are kept.
 * Sorted by provider, then name, then ID; an ID appears once.
 */
export function buildModelOptions(profiles: readonly InferenceProfileSummary[], models: readonly FoundationModelSummary[] | null): ModelOption[] {
  const textModels = models ? new Map(models.filter(canGenerateText).filter((m) => m.modelId).map((m) => [m.modelId!, m])) : null;
  const out = new Map<string, ModelOption>();
  for (const p of profiles) {
    if (!p.inferenceProfileId) continue;
    const ids = (p.models ?? []).map((m) => modelIdFromArn(m.modelArn)).filter((x): x is string => Boolean(x));
    if (textModels && !ids.some((id) => textModels.has(id))) continue;
    out.set(p.inferenceProfileId, {
      id: p.inferenceProfileId,
      label: p.inferenceProfileName?.trim() || p.inferenceProfileId,
      kind: "inference-profile",
      provider: providerOf(ids[0] ?? p.inferenceProfileId.split(".").slice(1).join(".") ?? null, textModels ?? new Map()),
      status: p.status ?? null,
    });
  }
  for (const m of textModels?.values() ?? []) {
    if (!onDemand(m) || out.has(m.modelId!)) continue;
    out.set(m.modelId!, {
      id: m.modelId!,
      label: m.modelName?.trim() || m.modelId!,
      kind: "foundation-model",
      provider: m.providerName ?? providerOf(m.modelId!, textModels!),
      status: m.modelLifecycle?.status ?? null,
    });
  }
  return [...out.values()].sort(compareOptions);
}

const KIND_ORDER: Record<ModelOption["kind"], number> = { "inference-profile": 0, "foundation-model": 1 };

function compareOptions(a: ModelOption, b: ModelOption): number {
  const pa = (a.provider ?? "\uffff").toLowerCase();
  const pb = (b.provider ?? "\uffff").toLowerCase();
  return (
    pa.localeCompare(pb) ||
    a.label.localeCompare(b.label, undefined, { numeric: true, sensitivity: "base" }) ||
    KIND_ORDER[a.kind] - KIND_ORDER[b.kind] ||
    a.id.localeCompare(b.id)
  );
}

type Settled<T> = { ok: true; value: T } | { ok: false; error: unknown };

async function settle<T>(fn: () => Promise<T>): Promise<Settled<T>> {
  try {
    return { ok: true, value: await fn() };
  } catch (error) {
    return { ok: false, error };
  }
}

async function readProfiles(client: Send): Promise<InferenceProfileSummary[]> {
  const out: InferenceProfileSummary[] = [];
  const call = (req: { nextToken?: string }) => client.send(new ListInferenceProfilesCommand({ ...req, typeEquals: "SYSTEM_DEFINED", maxResults: CATALOG.pageSize }));
  for await (const page of pages(call, {}, { maxPages: CATALOG.maxPages })) out.push(...(page.inferenceProfileSummaries ?? []));
  return out;
}

async function readModels(client: Send): Promise<FoundationModelSummary[]> {
  // Text output only; on-demand is filtered here, because the full text list
  // also tells which inference profiles serve text models.
  const res = await client.send(new ListFoundationModelsCommand({ byOutputModality: "TEXT" }));
  return res.modelSummaries ?? [];
}

/**
 * Lists the text models the space's read role can see in `region`
 * (ModelCatalog contract in ./models.ts). Successful lists are cached per space, role and
 * Region for CATALOG.ttlMs; a failure is not cached, so a fixed role shows up
 * on the next open.
 */
export async function listModels(space: SpaceAwsConfig, actor: Actor, region: string, deps: CatalogDeps = {}): Promise<ModelCatalog> {
  const now = deps.now ?? Date.now;
  const key = cacheKey(space, region);
  const hit = cache.get(key);
  if (hit && now() - hit.at < CATALOG.ttlMs) return hit.catalog;

  let client: Send;
  try {
    client = deps.client ?? bedrockClient(space, actor, region);
  } catch (err) {
    const f = catalogFailure(err, MODEL_IAM.list);
    return { region, models: [], error: f.message, errorKind: f.kind, errorDetail: f.detail, fetchedAt: new Date(now()).toISOString() };
  }
  const [profiles, models] = await Promise.all([settle(() => readProfiles(client)), settle(() => readModels(client))]);
  const failed = [!profiles.ok ? { action: "bedrock:ListInferenceProfiles", error: profiles.error } : null, !models.ok ? { action: "bedrock:ListFoundationModels", error: models.error } : null].filter(
    (x): x is { action: string; error: unknown } => x !== null,
  );
  const options = profiles.ok || models.ok ? buildModelOptions(profiles.ok ? profiles.value : [], models.ok ? models.value : null) : [];
  const f = failed.length ? catalogFailure(failed[0]!.error, failed.map((x) => x.action)) : null;
  const catalog: ModelCatalog = { region, models: options, error: f?.message ?? null, errorKind: f?.kind ?? null, errorDetail: f?.detail ?? null, fetchedAt: new Date(now()).toISOString() };
  if (!f) cache.set(key, { at: now(), catalog });
  return catalog;
}
