import {
  Check,
  CircleCheck,
  CircleDashed,
  CircleMinus,
  CirclePlus,
  CircleX,
  Clock,
  Equal,
  Loader,
  Power,
  PowerOff,
  Settings2,
  SquarePen,
  Trash2,
  TriangleAlert,
  type LucideIcon,
} from "lucide-react";
import type { ValidationResult } from "@/server/validation/types";

/**
 * One word set for statuses and changes (design-system MASTER "Statuses").
 * Pure tables and helpers, shared by StatusBadge, ChangeChip and ValidationList.
 */

export type StatusTone = "neutral" | "info" | "success" | "warning" | "destructive";

export interface StatusSpec {
  tone: StatusTone;
  icon?: LucideIcon;
  label: string;
}

/** Plan states, validation and connection, as StatusBadge props: `<StatusBadge {...STATUS.applied} />`. */
export const STATUS = {
  waitingForApproval: { tone: "warning", icon: Clock, label: "Waiting for approval" },
  applying: { tone: "info", icon: Loader, label: "Applying" },
  applied: { tone: "success", icon: CircleCheck, label: "Applied" },
  failed: { tone: "destructive", icon: CircleX, label: "Failed" },
  passed: { tone: "success", icon: Check, label: "Passed" },
  validationFailed: { tone: "destructive", icon: CircleX, label: "Failed" },
  notChecked: { tone: "neutral", label: "Not checked" },
  connected: { tone: "success", icon: CircleCheck, label: "Connected" },
  connectionFailed: { tone: "destructive", icon: CircleX, label: "Connection failed" },
  notTested: { tone: "neutral", icon: CircleDashed, label: "Not tested" },
  draft: { tone: "info", icon: SquarePen, label: "Draft" },
} as const satisfies Record<string, StatusSpec>;

/** Connection words for `connectionView().status` (src/server/spaces/connection-state.ts); a rejected test reads as failed. */
export function connectionStatusSpec(status: string): StatusSpec {
  return status === "ok" ? STATUS.connected : status === "failed" || status === "rejected" ? STATUS.connectionFailed : STATUS.notTested;
}

const plural = (n: number, one: string, other: string) => `${n} ${n === 1 ? one : other}`;

/** Badge for a set of validation results: "Passed", "1 error" (errors win) or "2 warnings"; "Not checked" when null. */
export function validationStatus(results: readonly ValidationResult[] | null | undefined): StatusSpec {
  if (!results) return STATUS.notChecked;
  const errors = results.filter((r) => r.level === "error").length;
  if (errors) return { tone: "destructive", icon: CircleX, label: plural(errors, "error", "errors") };
  const warnings = results.length - errors;
  if (warnings) return { tone: "warning", icon: TriangleAlert, label: plural(warnings, "warning", "warnings") };
  return STATUS.passed;
}

/** Errors first, then warnings; order within a level is kept. */
export function sortValidation(results: readonly ValidationResult[]): ValidationResult[] {
  return [...results.filter((r) => r.level === "error"), ...results.filter((r) => r.level !== "error")];
}

export type ChangeTone = "info" | "agent" | "warning" | "muted" | "success" | "destructive";

/**
 * Change words for plan items, drift and imports, mapped to tone and icon in
 * one table. ChangeChip shows the default label unless the caller passes a
 * more specific one ("Update v5 to v6", "Live is v2").
 */
export const CHANGE_WORDS = {
  create: { tone: "success", icon: CirclePlus, label: "Create" },
  "update-content": { tone: "info", icon: SquarePen, label: "Update content" },
  "set-inactive": { tone: "agent", icon: PowerOff, label: "Set Inactive" },
  "set-active": { tone: "agent", icon: Power, label: "Set Active" },
  "metadata-only": { tone: "agent", icon: Settings2, label: "Metadata only" },
  "skip-live-changed": { tone: "warning", icon: TriangleAlert, label: "Skip: live changed" },
  "no-change": { tone: "muted", icon: Equal, label: "No change" },
  unchanged: { tone: "muted", icon: Equal, label: "Unchanged" },
  delete: { tone: "destructive", icon: Trash2, label: "Delete" },
  added: { tone: "success", icon: CirclePlus, label: "Added" },
  removed: { tone: "destructive", icon: CircleMinus, label: "Removed" },
} as const satisfies Record<string, { tone: ChangeTone; icon: LucideIcon; label: string }>;

export type ChangeWord = keyof typeof CHANGE_WORDS;
