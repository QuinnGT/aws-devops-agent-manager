import { MockLanguageModelV4 } from "ai/test";
import { describe, expect, it, vi } from "vitest";
import { runReview } from "./index";
import { runInput, syntheticBundle, validBenchmarkOutput } from "./test-support";

const model = new MockLanguageModelV4({
  doGenerate: [
    {
      content: [{ type: "text", text: JSON.stringify(validBenchmarkOutput()) }],
      finishReason: { unified: "stop", raw: undefined },
      usage: {
        inputTokens: { total: 1, noCache: 1, cacheRead: undefined, cacheWrite: undefined },
        outputTokens: { total: 1, text: 1, reasoning: undefined },
      },
      warnings: [],
    },
  ],
});

const bedrockModel = vi.fn((..._args: unknown[]) => model);
vi.mock("@/server/ai/bedrock", () => ({ bedrockModel: (...args: unknown[]) => bedrockModel(...args) }));

describe("runReview without an injected model", () => {
  it("builds the model with bedrockModel from the profile's model ID and the input's region", async () => {
    const input = runInput(syntheticBundle([{ text: "start" }, { text: "no consumer lag query" }, { text: "a timing race" }]), { region: "eu-west-1" });
    const r = await runReview(input);
    expect(r.state).toBe("succeeded");
    expect(bedrockModel).toHaveBeenCalledTimes(1);
    expect(bedrockModel).toHaveBeenCalledWith(input.space, input.actor, input.profile.review.modelId, "eu-west-1");
    expect(r.modelCalls[0]).toMatchObject({ region: "eu-west-1", modelId: input.profile.review.modelId });
  });
});
