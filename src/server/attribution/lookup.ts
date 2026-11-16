import { type CloudTrailClient, type Event as LookupEvent, LookupEventsCommand } from "@aws-sdk/client-cloudtrail";
import type { Clock, RateLimiter } from "./rate-limiter";

/**
 * CloudTrail LookupEvents for one asset: filtered by ResourceName = asset ID
 * (asset writes list the asset as an AWS::AIDevOps::Asset resource named by
 * its ID), every page, each request spaced by the shared rate limiter.
 */

export interface LookupSettings {
  maxResults: number;
  maxPagesPerAsset: number;
  throttleRetries: number;
  throttleBackoffMs: number;
}

export interface AssetLookupResult {
  events: LookupEvent[];
  /** False when maxPagesPerAsset stopped the paging */
  complete: boolean;
  requests: number;
}

export function isThrottlingError(err: unknown): boolean {
  if (typeof err !== "object" || err === null) return false;
  const e = err as { name?: unknown; $retryable?: { throttling?: unknown }; $metadata?: { httpStatusCode?: unknown } };
  return (
    e.name === "ThrottlingException" ||
    e.name === "TooManyRequestsException" ||
    e.$retryable?.throttling === true ||
    e.$metadata?.httpStatusCode === 429
  );
}

export async function lookupAssetEvents(
  client: CloudTrailClient,
  assetId: string,
  range: { start: Date; end: Date },
  settings: LookupSettings,
  limiter: RateLimiter,
  clock: Clock,
): Promise<AssetLookupResult> {
  const events: LookupEvent[] = [];
  let nextToken: string | undefined;
  let pages = 0;
  let requests = 0;

  do {
    let attempt = 0;
    for (;;) {
      await limiter.acquire();
      requests++;
      try {
        // NextToken must be sent with the same parameters as the first call.
        const res = await client.send(
          new LookupEventsCommand({
            LookupAttributes: [{ AttributeKey: "ResourceName", AttributeValue: assetId }],
            StartTime: range.start,
            EndTime: range.end,
            MaxResults: settings.maxResults,
            NextToken: nextToken,
          }),
        );
        events.push(...(res.Events ?? []));
        nextToken = res.NextToken || undefined;
        break;
      } catch (err) {
        if (!isThrottlingError(err) || attempt >= settings.throttleRetries) throw err;
        await clock.sleep(settings.throttleBackoffMs * 2 ** attempt);
        attempt++;
      }
    }
    pages++;
  } while (nextToken && pages < settings.maxPagesPerAsset);

  return { events, complete: !nextToken, requests };
}
