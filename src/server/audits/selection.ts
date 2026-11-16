import { and, asc, count, eq, gte, inArray, lt, type SQL } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/server/db/client";
import { journalTasks } from "@/server/db/schema";
import type { AuditProfile } from "@/server/policy/sections/audits";
import { AuditRequestError } from "./errors";

/**
 * Choosing the investigations of an audit from the journal cache: task IDs,
 * incident IDs (journal_tasks.incident_id), or a created-time range with
 * optional statuses and task types. Each group may name a cohort for profiles
 * that compare cohorts. IDs from the client are checked against the space.
 */

const id = z.string().trim().min(1).max(300);
const cohort = z.string().trim().min(1).max(50).optional();

export const selectionSchema = z.discriminatedUnion("by", [
  z.object({ by: z.literal("tasks"), taskIds: z.array(id).min(1).max(5000), cohort }),
  z.object({ by: z.literal("incidents"), incidentIds: z.array(id).min(1).max(5000), cohort }),
  z
    .object({
      by: z.literal("range"),
      /** Created at or after */
      from: z.coerce.date(),
      /** Created before */
      to: z.coerce.date(),
      statuses: z.array(z.string().trim().min(1).max(64)).max(50).optional(),
      taskTypes: z.array(z.string().trim().min(1).max(64)).max(50).optional(),
      cohort,
    })
    .refine((s) => s.from < s.to, { message: "The range must end after it starts.", path: ["to"] }),
]);

export type Selection = z.output<typeof selectionSchema>;

export interface SelectedTask {
  taskId: string;
  incidentId: string | null;
}

export interface SelectedItem extends SelectedTask {
  cohort: string | null;
}

const listText = (xs: string[], max = 5) => `${xs.slice(0, max).join(", ")}${xs.length > max ? ` and ${xs.length - max} more` : ""}`;

/** Investigations a selection names, in a stable order. Throws AuditRequestError for IDs that are not in the space. */
export async function resolveSelection(spaceId: string, s: Selection, maxItems: number): Promise<SelectedTask[]> {
  const cols = { taskId: journalTasks.taskId, incidentId: journalTasks.incidentId };
  if (s.by === "tasks") {
    const ids = [...new Set(s.taskIds)];
    const rows = await db()
      .select(cols)
      .from(journalTasks)
      .where(and(eq(journalTasks.spaceId, spaceId), inArray(journalTasks.taskId, ids)));
    const known = new Map(rows.map((r) => [r.taskId, r]));
    const unknown = ids.filter((t) => !known.has(t));
    if (unknown.length) {
      throw new AuditRequestError("invalid", `${unknown.length} investigation(s) are not in this space's journal cache: ${listText(unknown)}.`, { unknownTaskIds: unknown });
    }
    return ids.map((t) => known.get(t)!);
  }
  if (s.by === "incidents") {
    const ids = [...new Set(s.incidentIds)];
    const rows = await db()
      .select(cols)
      .from(journalTasks)
      .where(and(eq(journalTasks.spaceId, spaceId), inArray(journalTasks.incidentId, ids)))
      .orderBy(asc(journalTasks.createdAt), asc(journalTasks.taskId));
    const found = new Set(rows.map((r) => r.incidentId));
    const unknown = ids.filter((i) => !found.has(i));
    if (unknown.length) {
      throw new AuditRequestError("invalid", `No investigation in this space's journal cache has incident ID ${listText(unknown)}.`, { unknownIncidentIds: unknown });
    }
    return rows;
  }
  const where: SQL[] = [eq(journalTasks.spaceId, spaceId), gte(journalTasks.createdAt, s.from), lt(journalTasks.createdAt, s.to)];
  if (s.statuses?.length) where.push(inArray(journalTasks.status, s.statuses));
  if (s.taskTypes?.length) where.push(inArray(journalTasks.taskType, s.taskTypes));
  const [{ n } = { n: 0 }] = await db()
    .select({ n: count() })
    .from(journalTasks)
    .where(and(...where));
  if (n === 0) throw new AuditRequestError("invalid", "No investigation in the journal cache matches the range and filters.");
  if (n > maxItems) throw new AuditRequestError("invalid", `The range matches ${n} investigations; an audit takes at most ${maxItems}.`, { matched: n, maxItems });
  return db()
    .select(cols)
    .from(journalTasks)
    .where(and(...where))
    .orderBy(asc(journalTasks.createdAt), asc(journalTasks.taskId));
}

/**
 * Items from resolved selection groups, with cohorts. Pure. A profile without
 * cohorts takes no cohort; a profile with cohorts needs one of its IDs on every
 * group, and a task can't be in two cohorts.
 */
export function assignCohorts(groups: { cohort?: string | null; tasks: SelectedTask[] }[], profile: Pick<AuditProfile, "cohorts">): SelectedItem[] {
  const ids = profile.cohorts.map((c) => c.id);
  const byTask = new Map<string, SelectedItem>();
  for (const g of groups) {
    const c = g.cohort ?? null;
    if (!ids.length && c) throw new AuditRequestError("invalid", "This audit profile does not compare cohorts; leave the cohort out.");
    if (ids.length && !c) throw new AuditRequestError("invalid", `Choose a cohort for every group of investigations (${profile.cohorts.map((x) => x.label).join(" or ")}).`);
    if (c && !ids.includes(c)) throw new AuditRequestError("invalid", `"${c}" is not a cohort of this profile.`);
    for (const t of g.tasks) {
      const prev = byTask.get(t.taskId);
      if (prev && prev.cohort !== c) {
        throw new AuditRequestError("invalid", `Investigation ${t.taskId} is in two cohorts (${prev.cohort} and ${c}).`, { taskId: t.taskId });
      }
      if (!prev) byTask.set(t.taskId, { ...t, cohort: c });
    }
  }
  return [...byTask.values()];
}

export function assertWithinLimit(n: number, maxItems: number): void {
  if (n > maxItems) throw new AuditRequestError("invalid", `An audit takes at most ${maxItems} investigations; this one would have ${n}.`, { items: n, maxItems });
}
