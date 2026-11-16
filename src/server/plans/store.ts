import { and, asc, eq, inArray } from "drizzle-orm";
import { db } from "@/server/db/client";
import { applyRuns, drafts, planItems, plans } from "@/server/db/schema";
import type { ApplyRunRow, PlanItemRow, PlanRow, PlanState } from "./types";

/**
 * Persistence used by the check and apply jobs, behind an interface so the
 * jobs can be unit-tested with an in-memory store (./testing.ts).
 */

export type PlanPatch = Partial<Omit<PlanRow, "id" | "spaceId" | "createdAt">>;
export type ItemPatch = Partial<Omit<PlanItemRow, "id" | "planId" | "createdAt">>;
export type ApplyRunPatch = Partial<Omit<ApplyRunRow, "id" | "planId" | "spaceId">>;

export interface PlanStore {
  getPlan(planId: string): Promise<PlanRow | null>;
  getItems(planId: string): Promise<PlanItemRow[]>;
  /** Update the plan; with `whereStates`, only when it is in one of them. Returns whether a row changed. */
  updatePlan(planId: string, patch: PlanPatch, opts?: { whereStates?: readonly PlanState[]; whereCheckRunId?: string | null }): Promise<boolean>;
  updateItem(itemId: string, patch: ItemPatch): Promise<void>;
  /** The apply run of this job (created on the first attempt, reused by pg-boss retries). */
  applyRunFor(input: { planId: string; spaceId: string; jobRunId: string | null; startedBy: string }): Promise<ApplyRunRow>;
  updateApplyRun(id: string, patch: ApplyRunPatch): Promise<void>;
  /** Draft status after apply: applied for written items, back to open for the rest. */
  settleDrafts(planId: string, applied: readonly string[], reopened: readonly string[]): Promise<void>;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const dbPlanStore: PlanStore = {
  async getPlan(planId) {
    if (!UUID_RE.test(planId)) return null;
    const [row] = await db().select().from(plans).where(eq(plans.id, planId));
    return row ?? null;
  },
  async getItems(planId) {
    return db().select().from(planItems).where(eq(planItems.planId, planId)).orderBy(asc(planItems.position));
  },
  async updatePlan(planId, patch, opts = {}) {
    const where = [eq(plans.id, planId)];
    if (opts.whereStates) where.push(inArray(plans.state, [...opts.whereStates]));
    if (opts.whereCheckRunId !== undefined && opts.whereCheckRunId !== null) where.push(eq(plans.checkRunId, opts.whereCheckRunId));
    const rows = await db()
      .update(plans)
      .set({ ...patch, updatedAt: new Date() })
      .where(and(...where))
      .returning({ id: plans.id });
    return rows.length > 0;
  },
  async updateItem(itemId, patch) {
    await db()
      .update(planItems)
      .set({ ...patch, updatedAt: new Date() })
      .where(eq(planItems.id, itemId));
  },
  async applyRunFor(input) {
    if (input.jobRunId && UUID_RE.test(input.jobRunId)) {
      const [existing] = await db().select().from(applyRuns).where(eq(applyRuns.jobRunId, input.jobRunId));
      if (existing) return existing;
    }
    const [row] = await db()
      .insert(applyRuns)
      .values({ planId: input.planId, spaceId: input.spaceId, jobRunId: input.jobRunId && UUID_RE.test(input.jobRunId) ? input.jobRunId : null, startedBy: input.startedBy })
      .returning();
    return row!;
  },
  async updateApplyRun(id, patch) {
    await db().update(applyRuns).set(patch).where(eq(applyRuns.id, id));
  },
  async settleDrafts(planId, applied, reopened) {
    if (applied.length) {
      await db()
        .update(drafts)
        .set({ status: "applied", updatedAt: new Date() })
        .where(and(eq(drafts.planId, planId), inArray(drafts.id, [...applied])));
    }
    if (reopened.length) {
      await db()
        .update(drafts)
        .set({ status: "open", planId: null, updatedAt: new Date() })
        .where(and(eq(drafts.planId, planId), inArray(drafts.id, [...reopened]), eq(drafts.status, "planned")));
    }
  },
};
