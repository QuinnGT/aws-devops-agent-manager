import { BedrockClient, ListFoundationModelsCommand, ListInferenceProfilesCommand, type FoundationModelSummary, type InferenceProfileSummary } from "@aws-sdk/client-bedrock";
import { mockClient } from "aws-sdk-client-mock";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { SpaceAwsConfig } from "@/server/aws/clients";
import { buildModelOptions, CATALOG, catalogErrorMessage, catalogFailure, listModels, modelIdFromArn, resetModelCatalogCache } from "./catalog";

// Example IDs only: nothing in this app names a real model.
const fm = (id: string, o: Partial<FoundationModelSummary> = {}): FoundationModelSummary => ({
  modelArn: `arn:aws:bedrock:us-west-2::foundation-model/${id}`,
  modelId: id,
  modelName: id,
  providerName: "Example",
  outputModalities: ["TEXT"],
  inferenceTypesSupported: ["ON_DEMAND"],
  modelLifecycle: { status: "ACTIVE" },
  ...o,
});

const profile = (id: string, name: string, modelIds: string[], o: Partial<InferenceProfileSummary> = {}): InferenceProfileSummary => ({
  inferenceProfileId: id,
  inferenceProfileName: name,
  inferenceProfileArn: `arn:aws:bedrock:us-west-2:111122223333:inference-profile/${id}`,
  models: modelIds.map((m) => ({ modelArn: `arn:aws:bedrock:us-west-2::foundation-model/${m}` })),
  status: "ACTIVE",
  type: "SYSTEM_DEFINED",
  ...o,
});

const MODELS: FoundationModelSummary[] = [
  // Needs an inference profile: no on-demand throughput (Bedrock returns INFERENCE_PROFILE, which the SDK's enum doesn't list)
  fm("zeta.big-text-v2:0", { modelName: "Big Text 2", providerName: "Zeta", inferenceTypesSupported: ["INFERENCE_PROFILE"] as unknown as FoundationModelSummary["inferenceTypesSupported"] }),
  fm("zeta.small-text-v1:0", { modelName: "Small Text", providerName: "Zeta" }),
  fm("alpha.chat-v1", { modelName: "Chat 10", providerName: "Alpha" }),
  fm("alpha.chat-v2", { modelName: "Chat 9", providerName: "Alpha" }),
  // Not a text generator: dropped
  fm("alpha.embed-v1", { modelName: "Embed", providerName: "Alpha", outputModalities: ["EMBEDDING"] }),
  fm("zeta.legacy-v1", { modelName: "Legacy", providerName: "Zeta", modelLifecycle: { status: "LEGACY" } }),
];

const PROFILES: InferenceProfileSummary[] = [
  profile("us.zeta.big-text-v2:0", "US Big Text 2", ["zeta.big-text-v2:0"]),
  profile("global.zeta.big-text-v2:0", "Global Big Text 2", ["zeta.big-text-v2:0"]),
  profile("us.alpha.embed-v1", "US Embed", ["alpha.embed-v1"]),
];

const space: SpaceAwsConfig = {
  id: "6f1d2c3b-4a5e-4f60-8a7b-9c0d1e2f3a4b",
  alias: "test-space",
  region: "us-west-2",
  accountId: "111122223333",
  agentSpaceId: "00000000-0000-4000-8000-0000000000bb",
  readRoleArn: null,
  writeRoleArn: null,
  externalId: null,
  awsProfile: null,
};
const actor = { email: "alex@example.com" };
const denied = () => Object.assign(new Error("User: arn:aws:sts::111122223333:assumed-role/read is not authorized to perform: bedrock:ListInferenceProfiles"), { name: "AccessDeniedException", $metadata: { httpStatusCode: 403 } });

const bedrock = mockClient(BedrockClient);

beforeEach(() => {
  bedrock.reset();
  resetModelCatalogCache();
});
afterEach(() => bedrock.reset());

describe("modelIdFromArn", () => {
  it("takes the model ID out of a foundation model ARN", () => {
    expect(modelIdFromArn("arn:aws:bedrock:us-east-1::foundation-model/zeta.big-text-v2:0")).toBe("zeta.big-text-v2:0");
    expect(modelIdFromArn("arn:aws:bedrock:us-east-1:111122223333:inference-profile/us.x")).toBeNull();
    expect(modelIdFromArn(undefined)).toBeNull();
  });
});

describe("buildModelOptions", () => {
  it("keeps text models, lists profile-only models through their profiles, and sorts by provider then name", () => {
    const options = buildModelOptions(PROFILES, MODELS);
    expect(options.map((o) => [o.provider, o.label, o.kind])).toEqual([
      ["Alpha", "Chat 9", "foundation-model"],
      ["Alpha", "Chat 10", "foundation-model"],
      ["Zeta", "Global Big Text 2", "inference-profile"],
      ["Zeta", "Legacy", "foundation-model"],
      ["Zeta", "Small Text", "foundation-model"],
      ["Zeta", "US Big Text 2", "inference-profile"],
    ]);
    // The model that needs a profile is not offered on its own, and the embedding model and its profile are dropped
    expect(options.map((o) => o.id)).not.toContain("zeta.big-text-v2:0");
    expect(options.map((o) => o.id)).not.toContain("alpha.embed-v1");
    expect(options.map((o) => o.id)).not.toContain("us.alpha.embed-v1");
    expect(options.find((o) => o.id === "zeta.legacy-v1")?.status).toBe("LEGACY");
  });

  it("keeps every profile when the foundation model list is unavailable, with the provider from the ID", () => {
    const options = buildModelOptions(PROFILES, null);
    expect(options.map((o) => o.id)).toEqual(["us.alpha.embed-v1", "global.zeta.big-text-v2:0", "us.zeta.big-text-v2:0"]);
    expect(options[0]!.provider).toBe("Alpha");
  });

  it("lists an ID once and falls back to the ID as the label", () => {
    const options = buildModelOptions([profile("us.x.y", "", ["x.y"])], [fm("x.y", { modelName: undefined, providerName: undefined })]);
    expect(options).toEqual([
      { id: "us.x.y", label: "us.x.y", kind: "inference-profile", provider: "X", status: "ACTIVE" },
      { id: "x.y", label: "x.y", kind: "foundation-model", provider: "X", status: "ACTIVE" },
    ]);
  });
});

describe("catalogErrorMessage", () => {
  const DENIED = "AWS refused the request: the space's read role isn't allowed to list Bedrock models. A typed model ID is used as is.";

  it("says the role was refused in plain words, with the IAM actions only in the Details line", () => {
    expect(catalogErrorMessage(denied())).toBe(DENIED);
    expect(catalogFailure(denied(), ["bedrock:ListInferenceProfiles", "bedrock:ListFoundationModels"])).toEqual({
      message: DENIED,
      kind: "access-denied",
      detail: "IAM actions refused: bedrock:ListInferenceProfiles, bedrock:ListFoundationModels",
    });
  });

  it("says what to do for missing or expired credentials, throttling and network failures, and never repeats the raw error", () => {
    const noCreds = Object.assign(new Error("Could not resolve credentials using profile: [dam-demo-no-aws] in configuration/credentials file(s)."), { name: "CredentialsProviderError" });
    expect(catalogErrorMessage(noCreds)).toBe("This app has no AWS credentials for this space, so it can't reach AWS. You can still type a model ID.");
    expect(catalogFailure(noCreds, []).kind).toBe("no-credentials");
    expect(catalogFailure(noCreds, []).detail).toMatch(/^CredentialsProviderError: Could not resolve credentials/);
    expect(catalogErrorMessage(Object.assign(new Error("The security token included in the request is expired"), { name: "ExpiredTokenException" }))).toMatch(/expired/);
    expect(catalogErrorMessage(Object.assign(new Error("Rate exceeded"), { name: "ThrottlingException" }))).toMatch(/limiting requests/);
    expect(catalogFailure(Object.assign(new Error("Rate exceeded"), { name: "ThrottlingException" }), []).kind).toBe("throttled");
    expect(catalogErrorMessage(new Error("getaddrinfo ENOTFOUND bedrock.us-west-2.amazonaws.com"))).toMatch(/can't be reached/);
    expect(catalogFailure(new Error("getaddrinfo ENOTFOUND bedrock.us-west-2.amazonaws.com"), []).kind).toBe("network");
    const other = catalogErrorMessage(Object.assign(new Error("arn:aws:iam::111122223333:role/secret-thing broke"), { name: "InternalServerException" }));
    expect(other).toBe("The model list could not be read from Bedrock. Type a model ID.");
  });
});

describe("listModels", () => {
  it("reads system-defined profiles (every page) and text models through the read role", async () => {
    bedrock
      .on(ListInferenceProfilesCommand)
      .resolvesOnce({ inferenceProfileSummaries: [PROFILES[0]!], nextToken: "p2" })
      .resolvesOnce({ inferenceProfileSummaries: [PROFILES[1]!] });
    bedrock.on(ListFoundationModelsCommand).resolves({ modelSummaries: MODELS });
    const c = await listModels(space, actor, "us-east-1");
    expect(c.error).toBeNull();
    expect(c.errorKind).toBeNull();
    expect(c.region).toBe("us-east-1");
    expect(c.models.map((m) => m.id)).toEqual(["alpha.chat-v2", "alpha.chat-v1", "global.zeta.big-text-v2:0", "zeta.legacy-v1", "zeta.small-text-v1:0", "us.zeta.big-text-v2:0"]);
    const profileCalls = bedrock.commandCalls(ListInferenceProfilesCommand);
    expect(profileCalls.map((x) => x.args[0].input)).toEqual([
      { typeEquals: "SYSTEM_DEFINED", maxResults: CATALOG.pageSize },
      { typeEquals: "SYSTEM_DEFINED", maxResults: CATALOG.pageSize, nextToken: "p2" },
    ]);
    expect(bedrock.commandCalls(ListFoundationModelsCommand)[0]!.args[0].input).toEqual({ byOutputModality: "TEXT" });
    expect(await bedrock.call(0).thisValue.config.region()).toBe("us-east-1");
  });

  it("returns an error naming the IAM actions when both lists are denied, so the picker takes a typed ID", async () => {
    bedrock.on(ListInferenceProfilesCommand).rejects(denied());
    bedrock.on(ListFoundationModelsCommand).rejects(denied());
    const c = await listModels(space, actor, "us-west-2");
    expect(c.models).toEqual([]);
    expect(c.error).toBe("AWS refused the request: the space's read role isn't allowed to list Bedrock models. A typed model ID is used as is.");
    expect(c.errorKind).toBe("access-denied");
    expect(c.errorDetail).toBe("IAM actions refused: bedrock:ListInferenceProfiles, bedrock:ListFoundationModels");
  });

  it("keeps what one list returned when the other is denied, and names the missing action", async () => {
    bedrock.on(ListInferenceProfilesCommand).resolves({ inferenceProfileSummaries: PROFILES });
    bedrock.on(ListFoundationModelsCommand).rejects(denied());
    const c = await listModels(space, actor, "us-west-2");
    expect(c.models.map((m) => m.kind)).toEqual(["inference-profile", "inference-profile", "inference-profile"]);
    expect(c.error).toBe("AWS refused the request: the space's read role isn't allowed to list Bedrock models. A typed model ID is used as is.");
    expect(c.errorDetail).toBe("IAM action refused: bedrock:ListFoundationModels");
  });

  it("caches a list per space, role and Region for a few minutes, and never caches a failure", async () => {
    let now = 1_000_000;
    const clock = () => now;
    bedrock.on(ListInferenceProfilesCommand).resolves({ inferenceProfileSummaries: [] });
    bedrock.on(ListFoundationModelsCommand).resolves({ modelSummaries: MODELS });
    const first = await listModels(space, actor, "us-west-2", { now: clock });
    now += CATALOG.ttlMs - 1;
    expect(await listModels(space, { email: "someone@example.com" }, "us-west-2", { now: clock })).toBe(first);
    expect(bedrock.commandCalls(ListFoundationModelsCommand)).toHaveLength(1);

    // Another Region, another role: read again
    await listModels(space, actor, "eu-west-1", { now: clock });
    await listModels({ ...space, readRoleArn: "arn:aws:iam::111122223333:role/other" }, actor, "us-west-2", { now: clock });
    expect(bedrock.commandCalls(ListFoundationModelsCommand)).toHaveLength(3);

    // Expired: read again
    now += 2;
    await listModels(space, actor, "us-west-2", { now: clock });
    expect(bedrock.commandCalls(ListFoundationModelsCommand)).toHaveLength(4);

    // A failure is not kept: the next open reads again
    resetModelCatalogCache();
    bedrock.reset();
    bedrock.on(ListInferenceProfilesCommand).rejects(denied());
    bedrock.on(ListFoundationModelsCommand).rejects(denied());
    expect((await listModels(space, actor, "us-west-2", { now: clock })).error).not.toBeNull();
    bedrock.on(ListInferenceProfilesCommand).resolves({ inferenceProfileSummaries: [] });
    bedrock.on(ListFoundationModelsCommand).resolves({ modelSummaries: MODELS });
    expect((await listModels(space, actor, "us-west-2", { now: clock })).error).toBeNull();
  });
});
