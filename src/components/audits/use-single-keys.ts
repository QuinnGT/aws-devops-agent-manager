"use client";

import { useCallback, useSyncExternalStore } from "react";
import { SINGLE_KEYS_STORAGE } from "./shortcuts";

/**
 * The "Single keys" switch of the review pages (WCAG 2.1.4): on unless the person turned it off.
 * Stored per user in local storage, so the incident page and the Findings tab share it.
 */
export function useSingleKeys(): [boolean, (on: boolean) => void] {
  const subscribe = useCallback((cb: () => void) => {
    window.addEventListener("storage", cb);
    window.addEventListener("dam-single-keys", cb);
    return () => {
      window.removeEventListener("storage", cb);
      window.removeEventListener("dam-single-keys", cb);
    };
  }, []);
  const on = useSyncExternalStore(
    subscribe,
    () => window.localStorage.getItem(SINGLE_KEYS_STORAGE) !== "off",
    () => true,
  );
  const set = (v: boolean) => {
    window.localStorage.setItem(SINGLE_KEYS_STORAGE, v ? "on" : "off");
    window.dispatchEvent(new Event("dam-single-keys"));
  };
  return [on, set];
}

