import type { Event as LookupEvent } from "@aws-sdk/client-cloudtrail";
import { type PrincipalInfo, principalFromUserIdentity } from "./identity";

/**
 * Parse LookupEvents results into the fields attribution needs. Pure.
 *
 * Facts from the test space (test/fixtures/api/test-space/CloudTrail.LookupEvents.memory.json):
 * - requestParameters hold only the clientToken, never the metadata or content sent.
 * - responseElements.asset holds { assetId, assetType, version, createdAt, updatedAt },
 *   timestamps in epoch seconds. createdAt is the asset's creation time on every version.
 */

export interface WrittenAsset {
  assetId: string | null;
  version: number | null;
  createdAt: Date | null;
  updatedAt: Date | null;
}

export interface WriteEvent {
  eventId: string;
  eventName: string;
  eventSource: string;
  eventTime: Date;
  clientToken: string | null;
  identity: PrincipalInfo;
  /** The asset as returned by the write, when responseElements carry it */
  written: WrittenAsset | null;
}

export interface EventFilter {
  eventSource: string;
  writeEventNames: readonly string[];
  responseObjectPaths: readonly string[];
}

function obj(v: unknown): Record<string, unknown> | null {
  return typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

/** Epoch seconds, epoch milliseconds or an ISO string. */
export function parseTimestamp(v: unknown): Date | null {
  if (v instanceof Date) return Number.isNaN(v.getTime()) ? null : v;
  if (typeof v === "number" && Number.isFinite(v)) return new Date(v < 1e12 ? v * 1000 : v);
  if (typeof v === "string" && v.length > 0) {
    if (/^\d+(\.\d+)?$/.test(v)) return parseTimestamp(Number(v));
    const t = Date.parse(v);
    return Number.isNaN(t) ? null : new Date(t);
  }
  return null;
}

function at(root: Record<string, unknown>, dotPath: string): Record<string, unknown> | null {
  if (dotPath === "") return root;
  let cur: unknown = root;
  for (const key of dotPath.split(".")) cur = obj(cur)?.[key];
  return obj(cur);
}

/** First object at one of `paths` that carries a numeric version or an updatedAt. */
export function writtenAssetFrom(responseElements: unknown, paths: readonly string[]): WrittenAsset | null {
  const root = obj(responseElements);
  if (!root) return null;
  for (const p of paths) {
    const o = at(root, p);
    if (!o) continue;
    const version = typeof o.version === "number" && Number.isInteger(o.version) ? o.version : null;
    const updatedAt = parseTimestamp(o.updatedAt);
    if (version === null && updatedAt === null) continue;
    return {
      assetId: typeof o.assetId === "string" ? o.assetId : null,
      version,
      createdAt: parseTimestamp(o.createdAt),
      updatedAt,
    };
  }
  return null;
}

export type ParseResult = { ok: true; event: WriteEvent } | { ok: false; reason: "not-a-write" | "failed-call" | "unparsable" };

/**
 * Parse one LookupEvents entry. Returns not-a-write for read-only, other
 * services and event names outside policy, and failed-call for events with
 * an errorCode (the write did not happen).
 */
export function parseLookupEvent(e: LookupEvent, filter: EventFilter): ParseResult {
  let detail: Record<string, unknown> | null = null;
  try {
    detail = obj(e.CloudTrailEvent ? JSON.parse(e.CloudTrailEvent) : null);
  } catch {
    return { ok: false, reason: "unparsable" };
  }
  if (!detail) return { ok: false, reason: "unparsable" };

  const eventName = (typeof detail.eventName === "string" ? detail.eventName : e.EventName) ?? "";
  const eventSource = (typeof detail.eventSource === "string" ? detail.eventSource : e.EventSource) ?? "";
  const readOnly = detail.readOnly === true || e.ReadOnly === "true";
  if (readOnly || eventSource !== filter.eventSource || !filter.writeEventNames.includes(eventName)) {
    return { ok: false, reason: "not-a-write" };
  }
  if (typeof detail.errorCode === "string" && detail.errorCode.length > 0) return { ok: false, reason: "failed-call" };

  const eventTime = parseTimestamp(detail.eventTime) ?? (e.EventTime ? parseTimestamp(e.EventTime) : null);
  const eventId = (typeof detail.eventID === "string" ? detail.eventID : e.EventId) ?? null;
  if (!eventTime || !eventId) return { ok: false, reason: "unparsable" };

  const clientToken = obj(detail.requestParameters)?.clientToken;
  return {
    ok: true,
    event: {
      eventId,
      eventName,
      eventSource,
      eventTime,
      clientToken: typeof clientToken === "string" && clientToken.length > 0 ? clientToken : null,
      identity: principalFromUserIdentity(detail.userIdentity),
      written: writtenAssetFrom(detail.responseElements, filter.responseObjectPaths),
    },
  };
}
