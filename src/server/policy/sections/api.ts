import { z } from "zod";
import { defineSection } from "./define";

/** AWS API client behavior. */
export const apiSection = defineSection(
  "api.yaml",
  z.object({
    /** SDK retry attempts, used with retryMode "adaptive" */
    maxAttempts: z.number().int().min(1).max(20).default(8),
    /** Default parallel API calls per job (modules may have their own setting) */
    defaultConcurrency: z.number().int().min(1).max(32).default(4),
    /** Assumed-role session length */
    roleSessionSeconds: z.number().int().min(900).max(43200).default(3600),
    /** Page size for List* calls where the API allows one */
    pageSize: z.number().int().min(1).max(100).default(100),
    /** Seconds a job may sit in the queue before the UI says the background worker may not be running */
    workerWaitSeconds: z.number().int().min(1).max(3600).default(20),
  }),
);
