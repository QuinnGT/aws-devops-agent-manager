import { createAmazonBedrock } from "@ai-sdk/amazon-bedrock";
import { bedrockCredentials, type Actor, type SpaceAwsConfig } from "@/server/aws/clients";
import type { SpaceSettings } from "@/server/spaces/settings-schema";

/**
 * The one place that builds a Bedrock model for
 * the AI SDK. Inference runs in the space's own
 * account through its read role, with the acting user as STS source identity.
 * The model ID always comes from policy (an audit profile), never from code.
 */

/** Bedrock region for a space: the inference setting, else the space Region. */
export function inferenceRegion(space: Pick<SpaceAwsConfig, "region">, settings: Pick<SpaceSettings, "inference"> | null | undefined): string {
  return settings?.inference.region ?? space.region;
}

/** An AI SDK language model for `modelId` (a Bedrock model ID or inference profile ID). */
export function bedrockModel(space: SpaceAwsConfig, actor: Actor, modelId: string, region: string) {
  const credentials = bedrockCredentials(space, actor);
  const provider = createAmazonBedrock({
    region,
    credentialProvider: async () => {
      const c = await credentials();
      return { accessKeyId: c.accessKeyId, secretAccessKey: c.secretAccessKey, sessionToken: c.sessionToken };
    },
  });
  return provider(modelId);
}
