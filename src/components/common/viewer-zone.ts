import "server-only";
import { cookies } from "next/headers";
import { resolveTimeZone, type ViewerZone } from "./time-format";

/** Name of the cookie the shell writes with the browser's IANA time zone. */
export const TZ_COOKIE = "tz";

/** The viewer's time zone from the `tz` cookie, or UTC (fallback) when it is missing or unknown. */
export async function getViewerZone(): Promise<ViewerZone> {
  return resolveTimeZone((await cookies()).get(TZ_COOKIE)?.value);
}
