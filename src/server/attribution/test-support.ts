import type { Event as LookupEvent } from "@aws-sdk/client-cloudtrail";
import { getAppPolicy, type Policy } from "@/server/policy";
import type { Clock } from "./rate-limiter";
import type { AssetChangeToAttribute } from "./types";

/** Test helpers for attribution (imported only by *.test.ts). */

export const ACCOUNT = "111122223333";
export const CONSOLE_ROLE_ARN = `arn:aws:sts::${ACCOUNT}:assumed-role/DevOpsAgentRole-WebappAdmin-abc123/AROAEXAMPLEMASKED0002-sam-Admin`;
export const CLI_ROLE_ARN = `arn:aws:sts::${ACCOUNT}:assumed-role/Admin/alice-cli`;
export const IAM_USER_ARN = `arn:aws:iam::${ACCOUNT}:user/deploy-bot`;
export const APP_WRITE_ROLE_ARN = `arn:aws:sts::${ACCOUNT}:assumed-role/DamWriteRole/dam-write-a-example.com`;

export type AttributionPolicy = Policy["attribution"];

export function attributionPolicy(overrides: Partial<AttributionPolicy> = {}): Pick<Policy, "attribution"> {
  const base = getAppPolicy().policy.attribution;
  return { attribution: { ...base, ...overrides } };
}

export function fakeClock(startIso: string): Clock & { sleeps: number[]; set(iso: string): void } {
  let t = Date.parse(startIso);
  const sleeps: number[] = [];
  return {
    now: () => t,
    sleep: async (ms) => {
      sleeps.push(ms);
      t += ms;
    },
    sleeps,
    set: (iso) => {
      t = Date.parse(iso);
    },
  };
}

const sec = (iso: string) => Math.floor(Date.parse(iso) / 1000);

export interface EventSpec {
  id: string;
  assetId: string;
  name?: string;
  time: string;
  arn?: string;
  type?: string;
  clientToken?: string;
  /** Written asset; null for no responseElements */
  written?: { version: number; createdAt: string; updatedAt: string } | null;
  errorCode?: string;
  readOnly?: boolean;
  source?: string;
}

/** A LookupEvents entry shaped like the captured test-space events. */
export function ctEvent(s: EventSpec): LookupEvent {
  const arn = s.arn ?? CONSOLE_ROLE_ARN;
  const type = s.type ?? (arn.includes(":assumed-role/") ? "AssumedRole" : "IAMUser");
  const name = s.name ?? "UpdateAsset";
  const detail: Record<string, unknown> = {
    eventVersion: "1.11",
    userIdentity: { type, principalId: `AROAEXAMPLE:${arn.split("/").pop()}`, arn, accountId: ACCOUNT },
    eventTime: s.time.replace(/\.\d{3}Z$/, "Z"),
    eventSource: s.source ?? "aidevops.amazonaws.com",
    eventName: name,
    awsRegion: "us-west-2",
    requestParameters: s.clientToken ? { clientToken: s.clientToken } : null,
    responseElements:
      s.written === null || s.written === undefined
        ? null
        : { asset: { assetId: s.assetId, assetType: "memory", version: s.written.version, createdAt: sec(s.written.createdAt), updatedAt: sec(s.written.updatedAt) } },
    eventID: s.id,
    readOnly: s.readOnly ?? false,
    eventType: "AwsApiCall",
    managementEvent: true,
    recipientAccountId: ACCOUNT,
    ...(s.errorCode ? { errorCode: s.errorCode, errorMessage: "failed" } : {}),
  };
  return {
    EventId: s.id,
    EventName: name,
    ReadOnly: String(s.readOnly ?? false),
    EventTime: new Date(s.time),
    EventSource: s.source ?? "aidevops.amazonaws.com",
    Resources: [{ ResourceType: "AWS::AIDevOps::Asset", ResourceName: s.assetId }],
    CloudTrailEvent: JSON.stringify(detail),
  };
}

export function change(c: Partial<AssetChangeToAttribute> & Pick<AssetChangeToAttribute, "assetId" | "serviceVersion">, updatedAt: string, createdAt = "2026-08-13T18:37:05.000Z"): AssetChangeToAttribute {
  return {
    assetType: "memory",
    changeKind: "content",
    serviceCreatedAt: new Date(createdAt),
    serviceUpdatedAt: new Date(updatedAt),
    ...c,
  };
}
