import type { FileVerdict, VerifyState } from "@/server/verify/types";

/**
 * Words for the release Verification tab (pages/release-verification.md,
 * "Verdicts"). Pure; unit-tested with ./views.ts.
 */

export type VerdictTone = "success" | "warning" | "muted";

export interface VerdictWords {
  words: string;
  tone: VerdictTone;
}

/** What the agent got, per file verdict (the worst outcome over the investigations wins). */
export const VERDICT_WORDS: Record<FileVerdict, VerdictWords> = {
  "release-body": { words: "Received the release's body", tone: "success" },
  "near-release": { words: "Received the release's body, almost exactly", tone: "success" },
  "older-body": { words: "Received an older body", tone: "warning" },
  "newer-body": { words: "Received a newer body", tone: "warning" },
  "other-body": { words: "Received a different body", tone: "warning" },
  "requested-no-body": { words: "Requested, nothing returned", tone: "warning" },
  "not-requested": { words: "Never requested", tone: "muted" },
};

/** Files the check didn't compare, shown in "All" only. Memories in managed stores are counted in the footer instead (managedNote). */
export const SKIPPED_WORDS = {
  inactive: { words: "Not offered", reason: "Inactive in this release, so it isn't offered" },
  "not-in-git": { words: "Not compared", reason: "Its content in the history repository doesn't match the release" },
} as const;

/** The footer line for memories in managed stores, which the check skips (policy verify.reads.managed). */
export function managedNote(n: number): string | null {
  if (!n) return null;
  return `${n} ${n === 1 ? "memory" : "memories"} in managed stores ${n === 1 ? "isn't" : "aren't"} compared: the agent keeps ${n === 1 ? "it" : "them"} up to date, so ${n === 1 ? "it changes" : "they change"} without a release.`;
}

/** The counts row of the agent-read card, in order. `always`: shown even at zero. */
export const READ_COUNT_WORDS: { key: "release" | "older" | "newer" | "other" | "no-body" | "never"; words: string; tone: VerdictTone; always: boolean }[] = [
  { key: "release", words: "received the release's body", tone: "success", always: true },
  { key: "older", words: "received an older body", tone: "warning", always: true },
  { key: "newer", words: "received a newer body", tone: "warning", always: false },
  { key: "other", words: "received a different body", tone: "warning", always: false },
  { key: "no-body", words: "requested, nothing returned", tone: "warning", always: true },
  { key: "never", words: "never requested", tone: "muted", always: true },
];

/** The words of a check that is queued or running. */
export const CHECKING = "Checking";

/** Why the newest run has no result, when it ended without one. */
export function endedWithoutResult(state: VerifyState): string | null {
  switch (state) {
    case "blocked":
      return "The last check couldn't run";
    case "failed":
      return "The last check failed";
    case "cancelled":
      return "The last check was cancelled";
    default:
      return null;
  }
}

export const NEVER_REQUESTED_NOTE = "A file the agent never requested isn't a failure on its own: the agent may not have needed it.";
/**
 * The footer line for asset types the check doesn't compare ("instruction
 * files and memory stores"). `inside` names what the check does compare in
 * those containers ({ items: "memories", containers: "memory stores" }), so
 * "memory stores" isn't read as "memories".
 */
export function notComparedNote(typeLabels: readonly string[], o: { inside?: { items: string; containers: string } | null } = {}): string | null {
  if (!typeLabels.length) return null;
  const list = typeLabels.length === 1 ? typeLabels[0]! : `${typeLabels.slice(0, -1).join(", ")} and ${typeLabels.at(-1)}`;
  const inside = o.inside ? ` The ${o.inside.items} inside those ${o.inside.containers} are compared: each one is a row of its own.` : "";
  return `Not compared: ${list}. The agent doesn't read them from a deployed file path.${inside}`;
}
