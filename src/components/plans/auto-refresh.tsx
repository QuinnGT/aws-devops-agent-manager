"use client";

import { useRouter } from "next/navigation";
import { useEffect } from "react";

/**
 * Refreshes the server-rendered page every `seconds` while `active`, for
 * plans that are checking or applying. Stops when the page no longer passes
 * `active` (the badge is the only busy indicator; no spinner here).
 */
export function AutoRefresh({ active, seconds }: { active: boolean; seconds: number }) {
  const router = useRouter();
  useEffect(() => {
    if (!active) return;
    const t = setInterval(() => {
      if (document.visibilityState === "visible") router.refresh();
    }, seconds * 1000);
    return () => clearInterval(t);
  }, [active, seconds, router]);
  return null;
}
