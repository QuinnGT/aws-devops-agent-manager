"use client";

import { useRouter } from "next/navigation";
import { useEffect } from "react";

/**
 * Writes the browser's IANA time zone to the `tz` cookie so server-rendered
 * times use it (MASTER "Time zone"). Refreshes once when the cookie changes.
 */
export function TzCookie({ current }: { current: string | null }) {
  const router = useRouter();
  useEffect(() => {
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
    if (!tz || tz === current) return;
    document.cookie = `tz=${encodeURIComponent(tz)}; path=/; max-age=31536000; samesite=lax`;
    router.refresh();
  }, [current, router]);
  return null;
}
