import { z } from "zod";
import { defineSection } from "./define";

/**
 * Validation limits from the asset, instruction and
 * memory guides, plus the safety caps for reading package folders and zips.
 *
 * Asset types refer to these keys by name (asset-types.yaml `limits` and
 * `counts`), so a limit has one value in one place.
 */
const MB = 1024 * 1024;

export const packageReadLimits = z.object({
  /** Largest package zip accepted for import (compressed bytes) */
  maxZipBytes: z.number().int().positive().default(32 * MB),
  /** Most files (zip entries or folder files) in one package, ignored ones included */
  maxEntries: z.number().int().positive().default(2000),
  /** Largest single file after decompression */
  maxEntryBytes: z.number().int().positive().default(16 * MB),
  /** Total bytes of all files after decompression */
  maxTotalBytes: z.number().int().positive().default(64 * MB),
  /** Longest path inside a package, in characters */
  maxPathLength: z.number().int().positive().default(512),
});

export const limitsSection = defineSection(
  "limits.yaml",
  z.object({
    agentsMdMaxBytes: z.number().int().positive().default(25 * 1024),
    agentsMdRecommendedLines: z.number().int().positive().default(120),
    zipMaxBytes: z.number().int().positive().default(6 * MB),
    singleTextFileMaxBytes: z.number().int().positive().default(1.5 * MB),
    /** content.file.body.bytes: base64-encoded binary content of one file (raw bytes) */
    binaryFileMaxBytes: z.number().int().positive().default(6 * MB),
    maxUserSkills: z.number().int().positive().default(200),
    maxMemoryStores: z.number().int().positive().default(50),
    maxMemoriesPerStore: z.number().int().positive().default(200),
    memoryMaxBytes: z.number().int().positive().default(100 * 1024),
    descriptionMaxChars: z.number().int().positive().default(1024),
    /**
     * Extra name rules on top of the service rules in asset-types.yaml:
     * asset type -> regular expression that `metadata.name` must also match
     * (for example a team prefix). Empty by default.
     */
    namePatterns: z
      .record(z.string(), z.string().refine(isValidRegExp, "must be a valid regular expression"))
      .default({}),
    /** Safety caps for reading package folders and zips (zip bombs, oversize uploads) */
    packageRead: packageReadLimits.default(packageReadLimits.parse({})),
  }),
);

/** Numeric limit keys that asset types may refer to by name. */
export const NUMERIC_LIMIT_KEYS = [
  "agentsMdMaxBytes",
  "agentsMdRecommendedLines",
  "zipMaxBytes",
  "singleTextFileMaxBytes",
  "binaryFileMaxBytes",
  "maxUserSkills",
  "maxMemoryStores",
  "maxMemoriesPerStore",
  "memoryMaxBytes",
  "descriptionMaxChars",
] as const;
export type NumericLimitKey = (typeof NUMERIC_LIMIT_KEYS)[number];

function isValidRegExp(s: string): boolean {
  try {
    new RegExp(s, "u");
    return true;
  } catch {
    return false;
  }
}
