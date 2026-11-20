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
  /** The chosen runner's option values (for example { modelTier: "smart" }) */
  runnerOptions: Record<string, string>;
  /** Text for {{record_access}} when the review uses tools */
  recordAccessPrompt: string;
  /** Reviews written from files (hand-off and chat) */
  files: { systemPrompt: string; recordAccessPrompt: string; recordCharsCap: number };
  /** Reviews that run as a DevOps Agent chat */
  chat: { messageTemplate: string; repairPrompt: string; schemaRepairPrompt: string; messageCharsCap: number; attachmentBytesCap: number; attachmentPrefix: string; cancelCheckSeconds: number };
}

export const REVIEW_DEFAULTS = {
  finalStepPrompt: "prompts/reviewer-final-step.md",
  analyzerCharsInPrompt: 12_000,
  groundTruthCharsInPrompt: 40_000,
  promptCache: false,
  recordAccessPrompt: "prompts/record-access-tools.md",
  files: { systemPrompt: "prompts/reviewer-system-files.md", recordAccessPrompt: "prompts/record-access-files.md", recordCharsCap: 20_000 },
  /**
   * messageCharsCap is the service's limit for one SendMessage content. attachmentBytesCap is
   * what a chat read in full in testing (1.8 MB), less a margin: 2.6 MB came back empty.
   * attachmentPrefix must match sync.yaml ignoredAttachmentPrefixes.
   */
  chat: {
    messageTemplate: "prompts/reviewer-chat.md",
    repairPrompt: "prompts/reviewer-chat-repair.md",
    schemaRepairPrompt: "prompts/reviewer-chat-schema-repair.md",
    messageCharsCap: 32_768,
    attachmentBytesCap: 1_500_000,
    attachmentPrefix: "dam-review-",
    cancelCheckSeconds: 2,
  },
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
    runnerOptions: r.runnerOptions ?? {},
    recordAccessPrompt: r.recordAccessPrompt ?? REVIEW_DEFAULTS.recordAccessPrompt,
    files: {
      systemPrompt: r.files?.systemPrompt ?? REVIEW_DEFAULTS.files.systemPrompt,
      recordAccessPrompt: r.files?.recordAccessPrompt ?? REVIEW_DEFAULTS.files.recordAccessPrompt,
      recordCharsCap: r.files?.recordCharsCap ?? REVIEW_DEFAULTS.files.recordCharsCap,
    },
    chat: {
      messageTemplate: r.chat?.messageTemplate ?? REVIEW_DEFAULTS.chat.messageTemplate,
      repairPrompt: r.chat?.repairPrompt ?? REVIEW_DEFAULTS.chat.repairPrompt,
      schemaRepairPrompt: r.chat?.schemaRepairPrompt ?? REVIEW_DEFAULTS.chat.schemaRepairPrompt,
      messageCharsCap: r.chat?.messageCharsCap ?? REVIEW_DEFAULTS.chat.messageCharsCap,
      attachmentBytesCap: r.chat?.attachmentBytesCap ?? REVIEW_DEFAULTS.chat.attachmentBytesCap,
      attachmentPrefix: r.chat?.attachmentPrefix ?? REVIEW_DEFAULTS.chat.attachmentPrefix,
      cancelCheckSeconds: r.chat?.cancelCheckSeconds ?? REVIEW_DEFAULTS.chat.cancelCheckSeconds,
    },
  };
}
