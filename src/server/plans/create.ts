import { and, eq, inArray } from "drizzle-orm";
import { z } from "zod";
import { recordAuditEvent } from "@/server/audit-log";
import type { Actor } from "@/server/aws/clients";
import { db } from "@/server/db/client";
import { assetIndex, planItems, plans } from "@/server/db/schema";
import { assetDisplayName } from "@/server/history/layout";
import { enqueue } from "@/server/jobs/enqueue";
import type { DesiredAsset } from "@/server/packages/types";
import { getAppPolicy } from "@/server/policy";
import { getSpaceById } from "@/server/spaces/queries";
import type { CreatePlan, CreatePlanInput, CreatePlanResult, PlanItemInput } from "./contract";
import { planCheckJob } from "./jobs";
import { PlanServiceError } from "./types";

/**
 * createPlan (contract in ./contract.ts): insert the plan in state
 * "checking" with its items, and enqueue its live-space check. The caller has
 * already checked `plans.create` for the space.
 */

type Db = ReturnType<typeof db>;
type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];

/** PlanItemInput plus the draft it came from (drafts and retries). */
export interface InternalPlanItemInput extends PlanItemInput {
  draftId?: string | null;
}

export interface InternalCreatePlanInput extends Omit<CreatePlanInput, "items"> {
  items: InternalPlanItemInput[];
}

const desiredFileSchema = z.looseObject({ path: z.string().min(1), encoding: z.enum(["utf8", "base64"]), content: z.string() });
const desiredSchema = z
  .looseObject({
    assetType: z.string().min(1),
    key: z.string(),
    assetId: z.string().min(1).optional(),
    metadata: z.record(z.string(), z.unknown()),
    files: z.array(desiredFileSchema),
    refs: z.record(z.string(), z.union([z.string(), z.array(z.string())])).optional(),
  });

const isoOrNull = z
  .union([z.string(), z.date()])
  .nullable()
  .optional()
  .transform((v, ctx) => {
    if (v === null || v === undefined) return null;
    const d = v instanceof Date ? v : new Date(v);
    if (Number.isNaN(d.getTime())) {
      ctx.addIssue({ code: "custom", message: "not a timestamp" });
      return z.NEVER;
    }
    return d;
  });

function inputSchema(limits: { maxItemsPerPlan: number; titleMaxChars: number; reasonMaxChars: number; noteMaxChars: number }) {
  return z
    .object({
      spaceId: z.string().uuid(),
      title: z.string().trim().min(1, "Enter a title").max(limits.titleMaxChars),
      origin: z.discriminatedUnion("kind", [
        z.object({ kind: z.literal("drafts"), draftIds: z.array(z.string()) }),
        z.object({ kind: z.literal("rollback"), target: z.record(z.string(), z.unknown()) }),
        z.object({ kind: z.literal("package"), importId: z.string(), fileName: z.string() }),
        z.object({ kind: z.literal("revision"), revisionId: z.string(), name: z.string() }),
        z.object({ kind: z.literal("retry"), planId: z.string() }),
      ]),
      items: z.array(
        z.object({
          desired: desiredSchema,
          baseVersion: z.number().int().nullable().optional(),
          baseUpdatedAt: isoOrNull,
          removeMetadataKeys: z.array(z.string()).optional(),
          note: z.string().max(limits.noteMaxChars).nullable().optional(),
          draftId: z.string().uuid().nullable().optional(),
        }),
      ),
      deletes: z.array(z.object({ assetId: z.string().min(1), note: z.string().max(limits.noteMaxChars).optional() })).optional(),
      reason: z.string().trim().max(limits.reasonMaxChars).nullable().optional(),
      notes: z.array(z.string().trim().min(1).max(limits.noteMaxChars)).max(limits.maxItemsPerPlan).optional(),
    })
    .refine((v) => v.items.length + (v.deletes?.length ?? 0) > 0, "A plan needs at least one item.")
    .refine((v) => v.items.length + (v.deletes?.length ?? 0) <= limits.maxItemsPerPlan, `A plan can hold at most ${limits.maxItemsPerPlan} items.`);
}

export function displayNameOf(desired: Pick<DesiredAsset, "assetType" | "metadata" | "key" | "assetId">): string {
  const name = assetDisplayName(getAppPolicy().policy.historyLayout, { assetId: desired.assetId ?? "", assetType: desired.assetType, metadata: desired.metadata });
  return name || desired.key || "(unnamed)";
}

/**
 * Insert the plan and its items; `inTx` runs in the same transaction (drafts
 * mark themselves planned there). Then enqueue the check.
 */
export async function createPlanInternal(
  raw: InternalCreatePlanInput,
  actor: Actor & { name?: string | null },
  opts: { inTx?: (tx: Tx, planId: string, items: { id: string; draftId: string | null }[]) => Promise<void> } = {},
): Promise<CreatePlanResult> {
  const policy = getAppPolicy().policy;
  const parsed = inputSchema(policy.plans.limits).safeParse(raw);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    throw new PlanServiceError(first?.message ?? "The plan input is not valid.", first?.path.length ? { [first.path.join(".")]: first.message } : {});
  }
  const input = parsed.data;
  const space = await getSpaceById(input.spaceId);
  if (!space) throw new PlanServiceError("Space not found.", {}, 404);
  const deletes = input.deletes ?? [];
  if (deletes.length && !space.parsedSettings.deletesEnabled) {
    throw new PlanServiceError("Deletes are off for this space. An Admin can turn on deletes in the space settings.");
  }
  const indexed = deletes.length
    ? await db()
        .select()
        .from(assetIndex)
        .where(and(eq(assetIndex.spaceId, space.id), inArray(assetIndex.assetId, deletes.map((d) => d.assetId))))
    : [];
  for (const d of deletes) {
    if (!indexed.some((r) => r.assetId === d.assetId && !r.deletedAt)) throw new PlanServiceError(`Asset ${d.assetId} is not a live asset of this space.`);
  }

  const planId = await db().transaction(async (tx) => {
    const [plan] = await tx
      .insert(plans)
      .values({
        spaceId: space.id,
        title: input.title,
        origin: raw.origin,
        originKind: input.origin.kind,
        state: "checking",
        reason: input.reason ?? null,
        notes: input.notes ?? [],
        createdBy: actor.email,
        createdByName: actor.name ?? null,
        checkRequestedBy: actor.email,
      })
      .returning({ id: plans.id });
    const values = [
      ...input.items.map((it, position) => {
        const desired = it.desired as unknown as DesiredAsset;
        return {
          planId: plan!.id,
          position,
          kind: "upsert" as const,
          assetType: desired.assetType,
          assetKey: desired.key,
          name: displayNameOf(desired),
          assetId: desired.assetId ?? null,
          desired,
          baseVersion: it.baseVersion ?? null,
          baseUpdatedAt: it.baseUpdatedAt ?? null,
          removeMetadataKeys: it.removeMetadataKeys ?? [],
          note: it.note ?? null,
          draftId: it.draftId ?? null,
        };
      }),
      ...deletes.map((d, i) => {
        const row = indexed.find((r) => r.assetId === d.assetId)!;
        return {
          planId: plan!.id,
          position: input.items.length + i,
          kind: "delete" as const,
          assetType: row.assetType,
          assetKey: row.name,
          name: row.name,
          assetId: d.assetId,
          desired: null,
          note: d.note ?? null,
        };
      }),
    ];
    const inserted = await tx.insert(planItems).values(values).returning({ id: planItems.id, draftId: planItems.draftId });
    await opts.inTx?.(tx, plan!.id, inserted);
    return plan!.id;
  });

  const checkRunId = await enqueue(planCheckJob, { planId, rebase: false }, { actor: { email: actor.email }, spaceId: space.id });
  await db().update(plans).set({ checkRunId }).where(and(eq(plans.id, planId), eq(plans.state, "checking")));
  await recordAuditEvent({
    actor,
    action: "plan.create",
    spaceId: space.id,
    targetType: "plan",
    targetId: planId,
    details: { title: input.title, origin: raw.origin, items: input.items.length, deletes: deletes.length, checkRunId },
  });
  return { planId, checkRunId };
}

export const createPlan: CreatePlan = (input, actor) => createPlanInternal(input, actor);
