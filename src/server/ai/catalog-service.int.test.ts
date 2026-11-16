import { BedrockClient, ListFoundationModelsCommand, ListInferenceProfilesCommand } from "@aws-sdk/client-bedrock";
import { mockClient } from "aws-sdk-client-mock";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { db } from "@/server/db/client";
import { agentSpaces } from "@/server/db/schema";
import { getSpaceByAlias, type Space } from "@/server/spaces/queries";
import { truncateAll } from "../../../test/helpers/db";
import { resetModelCatalogCache } from "./catalog";
import { modelCatalogFor, ModelCatalogError } from "./catalog-service";

// GET /api/spaces/<alias>/models: the Route Handler looks the space up and checks
// audits.run or spaces.manage, then calls modelCatalogFor. Bedrock is mocked.
const bedrock = mockClient(BedrockClient);
const actor = { email: "alex@example.com" };
const ALIAS = "models-space";

const model = { modelArn: "arn:aws:bedrock:eu-central-1::foundation-model/alpha.chat-v1", modelId: "alpha.chat-v1", modelName: "Chat", providerName: "Alpha", outputModalities: ["TEXT" as const], inferenceTypesSupported: ["ON_DEMAND" as const] };

async function space(): Promise<Space> {
  return (await getSpaceByAlias(ALIAS))!;
}

async function setInference(region: string | null) {
  await db()
    .update(agentSpaces)
    .set({ settings: { inference: { mode: "space", region, reviewModelId: null, reportModelId: null } } })
    .where(eq(agentSpaces.alias, ALIAS));
}

beforeAll(async () => {
  await truncateAll();
  await db().insert(agentSpaces).values({ alias: ALIAS, region: "us-west-2", accountId: "111122223333", agentSpaceId: "11111111-2222-4333-8444-555555555555" });
});

beforeEach(() => {
  bedrock.reset();
  resetModelCatalogCache();
  bedrock.on(ListInferenceProfilesCommand).resolves({ inferenceProfileSummaries: [] });
  bedrock.on(ListFoundationModelsCommand).resolves({ modelSummaries: [model] });
});

afterAll(() => bedrock.restore());

describe("modelCatalogFor", () => {
  it("lists in the space Region when no inference Region is set", async () => {
    await setInference(null);
    const c = await modelCatalogFor(await space(), actor, {});
    expect(c).toMatchObject({ region: "us-west-2", error: null, models: [{ id: "alpha.chat-v1", label: "Chat", provider: "Alpha", kind: "foundation-model" }] });
    expect(await bedrock.call(0).thisValue.config.region()).toBe("us-west-2");
  });

  it("uses the inference Region from Space settings, and a Region in the query over both", async () => {
    await setInference("eu-central-1");
    expect((await modelCatalogFor(await space(), actor, { region: "" })).region).toBe("eu-central-1");
    expect((await modelCatalogFor(await space(), actor, { region: "eu-west-1" })).region).toBe("eu-west-1");
  });

  it("refuses a Region that isn't a Region code", async () => {
    await expect(modelCatalogFor(await space(), actor, { region: "us-west-2/../x" })).rejects.toBeInstanceOf(ModelCatalogError);
    expect(bedrock.calls()).toHaveLength(0);
  });

  it("returns a plain error, not a failure, when the read role is denied", async () => {
    bedrock.reset();
    const denied = Object.assign(new Error("not authorized to perform: bedrock:ListFoundationModels"), { name: "AccessDeniedException", $metadata: { httpStatusCode: 403 } });
    bedrock.on(ListInferenceProfilesCommand).rejects(denied);
    bedrock.on(ListFoundationModelsCommand).rejects(denied);
    const c = await modelCatalogFor(await space(), actor, {});
    expect(c.models).toEqual([]);
    expect(c.error).toBe("AWS refused the request: the space's read role isn't allowed to list Bedrock models. A typed model ID is used as is.");
    expect(c.errorKind).toBe("access-denied");
    expect(c.errorDetail).toBe("IAM actions refused: bedrock:ListInferenceProfiles, bedrock:ListFoundationModels");
  });
});
