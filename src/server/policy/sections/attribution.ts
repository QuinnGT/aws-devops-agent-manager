import { z } from "zod";
import { defineSection } from "./define";

/**
 * Source attribution rules for asset changes. Rules, in order, first
 * match wins: app (clientToken of a plan item), a role pattern below,
 * cli (any other principal), the no-event source, unknown.
 */

const sourceLabel = z.enum(["console", "cli", "agent"]);
const noEventSource = z.enum(["agent", "unknown"]);

export const attributionSection = defineSection(
  "attribution.yaml",
  z.object({
    /** Only lookup-events is implemented; the others return "unknown" until they are */
    cloudTrailSource: z.enum(["lookup-events", "athena", "cloudtrail-lake"]).default("lookup-events"),
    /** Seconds around the change; used only when no event matches the version and timestamp exactly */
    matchWindowSeconds: z.number().int().positive().default(60),
    /**
     * Seconds CloudTrail may take to show an event. A change this recent with
     * no matching event is labeled unknown and marked provisional instead of agent.
     */
    eventDeliveryDelaySeconds: z.number().int().min(0).default(300),
    /** Source for a change with no matching write event (the DevOps Agent itself) */
    noEventSource: noEventSource.default("agent"),
    /** Per asset type override of noEventSource, e.g. agents_md: unknown if the agent cannot edit it */
    noEventSourceByAssetType: z.record(z.string(), noEventSource).default({}),
    events: z
      .object({
        eventSource: z.string().min(1).default("aidevops.amazonaws.com"),
        /** Write events that can change an asset */
        writeEventNames: z
          .array(z.string().min(1))
          .min(1)
          .default(["CreateAsset", "UpdateAsset", "CreateAssetFile", "UpdateAssetFile", "DeleteAssetFile", "DeleteAsset"]),
        /** Preferred for changeKind "created" when several events match */
        creationEventNames: z.array(z.string().min(1)).default(["CreateAsset"]),
        /** Matched for changeKind "deleted" by asset ID alone, at or after the last recorded update */
        deletionEventNames: z.array(z.string().min(1)).default(["DeleteAsset"]),
        /**
         * Dot paths inside responseElements where the written asset's
         * { assetId, version, createdAt, updatedAt } can appear; "" is the root.
         */
        responseObjectPaths: z.array(z.string()).default(["asset", "file", ""]),
      })
      .prefault({}),
    lookupEvents: z
      .object({
        /**
         * LookupEvents is limited to 2 requests per second per account and
         * Region (CloudTrail API reference). Keep headroom for the console and other tools.
         */
        requestsPerSecond: z.number().positive().default(1),
        /** 1 to 50 (API maximum) */
        maxResults: z.number().int().min(1).max(50).default(50),
        /** Safety cap; when reached, unmatched changes of that asset are labeled unknown */
        maxPagesPerAsset: z.number().int().positive().default(100),
        /** Extra attempts after a throttling error, on top of the SDK's own retries */
        throttleRetries: z.number().int().min(0).default(3),
        /** First backoff after a throttling error; doubles each attempt */
        throttleBackoffMs: z.number().int().positive().default(1000),
        /** LookupEvents covers the last 90 days; older changes are labeled unknown without a lookup */
        retentionDays: z.number().int().positive().default(90),
      })
      .prefault({}),
    /** Ordered principal patterns; first match wins. `*` is the only wildcard. */
    rolePatterns: z
      .array(
        z.object({
          pattern: z.string().min(1),
          /** Which part of the principal the pattern is tested against */
          match: z.enum(["roleName", "sessionName", "arn"]).default("roleName"),
          source: sourceLabel,
          label: z.string().min(1),
          /** Recorded principal; defaults to sessionName for console, arn otherwise */
          principal: z.enum(["sessionName", "roleName", "arn", "label"]).optional(),
        }),
      )
      .default([]),
    labels: z
      .object({
        app: z.string().default("DevOps Agent Manager"),
        console: z.string().default("Operator Web App"),
        cli: z.string().default("CLI or SDK"),
        agent: z.string().default("DevOps Agent"),
        unknown: z.string().default("Unknown"),
      })
      .prefault({}),
    /** Tooltip sentence for a source's chip (SourceBadge), shown in place of the principal */
    notes: z
      .partialRecord(z.enum(["app", "console", "cli", "agent", "unknown"]), z.string().min(1))
      .default({ agent: "No AWS API call was recorded for this change, so it's shown as made by the DevOps Agent." }),
    /** Chip text for each source (SourceBadge); `labels` stay the long form shown in tooltips and detail lines */
    shortLabels: z
      .object({
        app: z.string().min(1).default("This app"),
        console: z.string().min(1).default("Web app"),
        cli: z.string().min(1).default("CLI or SDK"),
        agent: z.string().min(1).default("DevOps Agent"),
        unknown: z.string().min(1).default("Unknown"),
      })
      .prefault({}),
  }),
);
