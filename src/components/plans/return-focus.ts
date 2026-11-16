"use client";

import { useRef } from "react";

/**
 * Focus return for dialogs opened from code (controlled AlertDialogs have no
 * Trigger for Radix to return focus to). Call `remember()` when opening and
 * pass `onCloseAutoFocus` to the dialog content.
 */
export function useReturnFocus() {
  const el = useRef<HTMLElement | null>(null);
  return {
    remember: () => {
      el.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    },
    onCloseAutoFocus: (e: Event) => {
      const target = el.current;
      if (target && target.isConnected) {
        e.preventDefault();
        target.focus();
      }
    },
  };
}
