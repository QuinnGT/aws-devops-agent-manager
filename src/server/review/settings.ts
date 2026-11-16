import type { AuditProfile } from "@/server/audits/contract";

/**
 * The profile's review settings with the reviewer's defaults filled in. The
 * optional fields have no Zod defaults so that profile objects built before
 * they existed still type-check; their defaults live here.
 */
export interface ReviewSettings {
  runner: string;
  /** Null when no model was chosen; the review then fails before any call */
  modelId: string | null;
  stepLimit: number;
  maxOutputTokens: number;
  timeoutSeconds: number;
  systemPrompt: string;
  promptTemplate: string;
  outputSchema: string;
  finalStepPrompt: string;
  traceCharsInPrompt: number;
  toolOutputCapChars: number;
  analyzerCharsInPrompt: number;
  groundTruthCharsInPrompt: number;
  promptCache: boolean;
  structuredOutputMode: "auto" | "outputFormat" | "jsonTool" | null;
}

export const REVIEW_DEFAULTS = {
  finalStepPrompt: "prompts/reviewer-final-step.md",
  analyzerCharsInPrompt: 12_000,
  groundTruthCharsInPrompt: 40_000,
  promptCache: false,
} as const;

export function reviewSettings(profile: AuditProfile): ReviewSettings {
  const r = profile.review;
  return {
    runner: r.runner,
    modelId: r.modelId ?? null,
    stepLimit: r.stepLimit,
    maxOutputTokens: r.maxOutputTokens,
    timeoutSeconds: r.timeoutSeconds,
    systemPrompt: r.systemPrompt,
    promptTemplate: r.promptTemplate,
    outputSchema: r.outputSchema,
    finalStepPrompt: r.finalStepPrompt ?? REVIEW_DEFAULTS.finalStepPrompt,
    traceCharsInPrompt: r.traceCharsInPrompt,
    toolOutputCapChars: r.toolOutputCapChars,
    analyzerCharsInPrompt: r.analyzerCharsInPrompt ?? REVIEW_DEFAULTS.analyzerCharsInPrompt,
    groundTruthCharsInPrompt: r.groundTruthCharsInPrompt ?? REVIEW_DEFAULTS.groundTruthCharsInPrompt,
    promptCache: r.promptCache ?? REVIEW_DEFAULTS.promptCache,
    structuredOutputMode: r.structuredOutputMode ?? null,
  };
}
