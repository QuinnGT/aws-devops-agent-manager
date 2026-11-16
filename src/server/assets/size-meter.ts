import type { Policy } from "@/server/policy";

/**
 * Size meter for instruction files (AGENTS.md): bytes against
 * limits.agentsMdMaxBytes and a warning above limits.agentsMdRecommendedLines.
 * Pure; unit-tested.
 */

export interface SizeMeter {
  bytes: number;
  maxBytes: number;
  lines: number;
  recommendedLines: number;
  /** bytes / maxBytes, not capped at 1 */
  fraction: number;
  /** More bytes than the service accepts */
  overLimit: boolean;
  /** More lines than the recommended length */
  overRecommendedLines: boolean;
  level: "ok" | "warning" | "error";
}

/** Lines as an editor counts them: a trailing newline does not start a new line. */
export function countLines(text: string): number {
  if (text === "") return 0;
  const n = text.split("\n").length;
  return text.endsWith("\n") ? n - 1 : n;
}

export function utf8Bytes(text: string): number {
  return Buffer.byteLength(text, "utf8");
}

export function measureInstructions(
  text: string,
  limits: Pick<Policy["limits"], "agentsMdMaxBytes" | "agentsMdRecommendedLines">,
): SizeMeter {
  const bytes = utf8Bytes(text);
  const lines = countLines(text);
  const overLimit = bytes > limits.agentsMdMaxBytes;
  const overRecommendedLines = lines > limits.agentsMdRecommendedLines;
  return {
    bytes,
    maxBytes: limits.agentsMdMaxBytes,
    lines,
    recommendedLines: limits.agentsMdRecommendedLines,
    fraction: limits.agentsMdMaxBytes > 0 ? bytes / limits.agentsMdMaxBytes : 0,
    overLimit,
    overRecommendedLines,
    level: overLimit ? "error" : overRecommendedLines ? "warning" : "ok",
  };
}

/** "12.3 KB" style size for the UI (1 KB = 1024 bytes, matching the guide's 25 KB limit). */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
