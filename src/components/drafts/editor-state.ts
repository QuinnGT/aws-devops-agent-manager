import { diffRecords, diffText, type FileDiff, type ValueChange } from "@/server/assets/diff";
import type { SizeMeter } from "@/server/assets/size-meter";
import type { DesiredFile } from "@/server/packages/types";

/**
 * Pure state logic of the draft editor (draft-editor.md): what changed since
 * the last save, the diff against live of the text in the editor, the size
 * meter, and the buttons by role and state. Unit-tested; no React.
 */

export interface EditableState {
  metadata: Record<string, unknown>;
  files: readonly DesiredFile[];
}

function stable(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(stable).join(",")}]`;
  if (v && typeof v === "object") {
    return `{${Object.keys(v)
      .sort()
      .filter((k) => (v as Record<string, unknown>)[k] !== undefined)
      .map((k) => `${JSON.stringify(k)}:${stable((v as Record<string, unknown>)[k])}`)
      .join(",")}}`;
  }
  return JSON.stringify(v);
}

export function sameMetadata(a: Record<string, unknown>, b: Record<string, unknown>): boolean {
  return stable(a) === stable(b);
}

/** Files whose content differs from the baseline (the ones a save sends). */
export function changedFiles(baseline: readonly DesiredFile[], current: readonly DesiredFile[]): DesiredFile[] {
  return current.filter((f) => {
    const b = baseline.find((x) => x.path === f.path);
    return !b || b.content !== f.content || b.encoding !== f.encoding;
  });
}

export function isDirty(baseline: EditableState, current: EditableState): boolean {
  return changedFiles(baseline.files, current.files).length > 0 || !sameMetadata(baseline.metadata, current.metadata);
}

const encoder = typeof TextEncoder !== "undefined" ? new TextEncoder() : null;

/** Lines as an editor counts them: a trailing newline does not start a new line. */
export function countLines(text: string): number {
  if (text === "") return 0;
  const n = text.split("\n").length;
  return text.endsWith("\n") ? n - 1 : n;
}

/** The instructions size meter for text in the browser, with the same rules as the server's measureInstructions. */
export function measureText(text: string, limits: { agentsMdMaxBytes: number; agentsMdRecommendedLines: number }): SizeMeter {
  const bytes = encoder ? encoder.encode(text).byteLength : text.length;
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

export interface AgainstFile {
  path: string;
  encoding: "utf8" | "base64";
  content: string | null;
}

/** Each file of the draft against the live (or last committed) version: every path, unchanged ones included. */
export function diffAgainst(against: readonly AgainstFile[], current: readonly DesiredFile[]): FileDiff[] {
  const paths = [...new Set([...current.map((f) => f.path), ...against.map((f) => f.path)])];
  return paths.map((path): FileDiff => {
    const a = against.find((f) => f.path === path);
    const b = current.find((f) => f.path === path);
    const base = { path, beforeSha: null, afterSha: null, hunks: [], added: 0, removed: 0 };
    if (a && b && a.content === b.content) return { ...base, status: "unchanged" };
    if ((a && (a.content === null || a.encoding !== "utf8")) || (b && b.encoding !== "utf8")) {
      return { ...base, status: a && b ? "not-comparable" : a ? "removed" : "added", reason: "Binary or not readable, so it is compared by hash only" };
    }
    const hunks = diffText(a?.content ?? "", b?.content ?? "") ?? [];
    const added = hunks.reduce((n, h) => n + h.lines.filter((l) => l.kind === "add").length, 0);
    const removed = hunks.reduce((n, h) => n + h.lines.filter((l) => l.kind === "del").length, 0);
    if (a && b && hunks.length === 0) return { ...base, status: "unchanged" };
    return { ...base, status: !a ? "added" : !b ? "removed" : "modified", hunks, added, removed };
  });
}

export function diffMetadata(against: Record<string, unknown> | null, current: Record<string, unknown>): ValueChange[] {
  return diffRecords(against ?? {}, current);
}

/** The count pill of the "Changes" tab: "+N −M", "status" for a status-only change, or null for no change. */
export function diffPill(files: readonly FileDiff[], metadata: readonly ValueChange[]): string | null {
  const added = files.reduce((n, f) => n + f.added, 0);
  const removed = files.reduce((n, f) => n + f.removed, 0);
  if (added || removed) return `+${added} −${removed}`;
  if (files.some((f) => f.status !== "unchanged")) return "changed";
  if (metadata.length === 1 && metadata[0]!.key === "status") return "status";
  if (metadata.length) return "metadata";
  return null;
}

export interface ButtonState {
  /** null: no Save button (someone else's draft) */
  save: { enabled: boolean; reason: string | null } | null;
  discard: boolean;
  /** "Cancel" back to the asset page, for a draft that isn't saved yet */
  cancel: boolean;
}

/** Buttons by role and state (draft-editor.md), first row that applies. */
export function editorButtons(s: { readOnly: boolean; exists: boolean; planTitle: string | null; assetDeleted: boolean; lockedReason: string | null; dirty: boolean; saving: boolean }): ButtonState {
  if (s.readOnly) return { save: null, discard: false, cancel: false };
  if (!s.exists) return { save: s.assetDeleted ? { enabled: false, reason: "The asset was deleted from the space." } : { enabled: !s.saving, reason: null }, discard: false, cancel: true };
  if (s.planTitle !== null) return { save: { enabled: false, reason: `This draft is in plan ${s.planTitle}.` }, discard: false, cancel: false };
  if (s.assetDeleted) return { save: { enabled: false, reason: "The asset was deleted from the space." }, discard: true, cancel: false };
  if (s.lockedReason) return { save: { enabled: false, reason: s.lockedReason }, discard: true, cancel: false };
  if (!s.dirty) return { save: { enabled: false, reason: "No unsaved changes" }, discard: true, cancel: false };
  return { save: { enabled: !s.saving, reason: null }, discard: true, cancel: false };
}

/** "Create plan from this draft" (draft page): null when it doesn't apply, else enabled or why not. */
export function createPlanButton(s: { canCreate: boolean; readOnly: boolean; exists: boolean; planTitle: string | null; assetDeleted: boolean; lockedReason: string | null; dirty: boolean; errors: number }): { enabled: boolean; reason: string | null } | null {
  if (!s.canCreate || s.readOnly || !s.exists || s.planTitle !== null || s.assetDeleted || s.lockedReason) return null;
  if (s.dirty) return { enabled: false, reason: "Save the draft first." };
  if (s.errors > 0) return { enabled: false, reason: "Fix the validation errors first." };
  return { enabled: true, reason: null };
}
