/**
 * Single-key shortcuts of the incident review (pages/audit-item.md,
 * "Keyboard shortcuts"): A accept, E edit, R reject, J next proposed finding,
 * K previous finding, O open the cited record. They work only while focus is
 * in the review area and not in a text field, and a switch turns them off
 * (WCAG 2.1.4). Pure; unit-tested. The component wires it to keydown.
 */

export type ShortcutAction = "accept" | "edit" | "reject" | "next" | "prev" | "open";

export const SHORTCUT_KEYS: { key: string; action: ShortcutAction; label: string }[] = [
  { key: "A", action: "accept", label: "Accept" },
  { key: "E", action: "edit", label: "Edit the fields" },
  { key: "R", action: "reject", label: "Reject, with an optional note" },
  { key: "J", action: "next", label: "Next proposed finding" },
  { key: "K", action: "prev", label: "Previous finding" },
  { key: "O", action: "open", label: "Open the cited record" },
];

const BY_KEY = new Map(SHORTCUT_KEYS.map((s) => [s.key.toLowerCase(), s.action]));

export interface KeyInput {
  key: string;
  altKey: boolean;
  ctrlKey: boolean;
  metaKey: boolean;
  /** Repeated keydown while held */
  repeat?: boolean;
  /** The event's target is a text field, select, contenteditable or inside an open dialog or popover */
  inTextField: boolean;
  /** The event's target is inside the review area */
  inReviewArea: boolean;
}

/** The action for a keydown, or null to let the browser handle it. Shift is allowed so Caps Lock and Shift+A both work. */
export function shortcutFor(e: KeyInput, enabled: boolean): ShortcutAction | null {
  if (!enabled || !e.inReviewArea || e.inTextField) return null;
  if (e.altKey || e.ctrlKey || e.metaKey || e.repeat) return null;
  if (e.key.length !== 1) return null;
  return BY_KEY.get(e.key.toLowerCase()) ?? null;
}

/** Whether an element takes typed text, so single keys must not be caught there. */
export function isTextTarget(el: { tagName?: string; isContentEditable?: boolean; type?: string; closest?: (sel: string) => unknown } | null): boolean {
  if (!el) return false;
  if (el.isContentEditable) return true;
  const tag = (el.tagName ?? "").toUpperCase();
  if (tag === "TEXTAREA" || tag === "SELECT") return true;
  if (tag === "INPUT") {
    const t = (el.type ?? "text").toLowerCase();
    return !["checkbox", "radio", "button", "submit", "reset", "range", "color", "file"].includes(t);
  }
  return !!el.closest?.('[role="dialog"], [role="listbox"], [role="menu"], [data-slot="popover-content"]');
}

/**
 * The next index in `ids` to focus for J (next proposed) or K (previous),
 * from `current` (-1 when none is focused). J skips decided findings and
 * stays put when none is left after the current one.
 */
export function moveFocus(ids: readonly { id: string; proposed: boolean }[], current: number, dir: "next" | "prev"): number {
  if (!ids.length) return -1;
  if (dir === "prev") return current <= 0 ? 0 : current - 1;
  for (let i = current + 1; i < ids.length; i++) if (ids[i]!.proposed) return i;
  return current < 0 ? 0 : current;
}

/** Local storage key of the "Single keys" switch. */
export const SINGLE_KEYS_STORAGE = "dam.audit-review.single-keys";
