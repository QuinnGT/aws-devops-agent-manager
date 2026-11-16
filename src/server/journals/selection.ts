import { z } from "zod";

/**
 * Export selection: a date range with task
 * type, status and priority filters, a list of task IDs, or a list of incident
 * IDs resolved through the space's incident ID rule.
 */

const dateOrDateTime = z
  .string()
  .trim()
  .refine((s) => /^\d{4}-\d{2}-\d{2}(T[\d:.]+(Z|[+-]\d{2}:\d{2})?)?$/.test(s) && !Number.isNaN(new Date(s).getTime()), "Use a date such as 2026-10-01");
const enumValue = z.string().trim().regex(/^[A-Z][A-Z0-9_]{0,63}$/, "Use the API's upper-case value, such as COMPLETED");
const idValue = z
  .string()
  .trim()
  .min(1)
  .max(256)
  .regex(/^[\w.:#/-]+$/, "IDs use letters, digits and . : # / - _");

export const exportSelectionSchema = z
  .object({
    mode: z.enum(["filter", "taskIds", "incidentIds"]).default("filter"),
    /** Inclusive start (createdAfter) */
    from: dateOrDateTime.optional(),
    /** Exclusive end (createdBefore). A plain date means the end of that day. */
    to: dateOrDateTime.optional(),
    taskTypes: z.array(enumValue).default([]),
    statuses: z.array(enumValue).default([]),
    priorities: z.array(enumValue).default([]),
    taskIds: z.array(idValue).default([]),
    incidentIds: z.array(idValue).default([]),
  })
  .superRefine((s, ctx) => {
    if (s.mode === "taskIds" && s.taskIds.length === 0) ctx.addIssue({ code: "custom", path: ["taskIds"], message: "Enter at least one task ID" });
    if (s.mode === "incidentIds" && s.incidentIds.length === 0)
      ctx.addIssue({ code: "custom", path: ["incidentIds"], message: "Enter at least one incident ID" });
    const r = dateRange(s);
    if (r.createdAfter && r.createdBefore && r.createdAfter >= r.createdBefore) ctx.addIssue({ code: "custom", path: ["to"], message: "The end date must be after the start date" });
  });

export type ExportSelection = z.output<typeof exportSelectionSchema>;

export function dateRange(s: Pick<ExportSelection, "from" | "to">): { createdAfter?: Date; createdBefore?: Date } {
  const out: { createdAfter?: Date; createdBefore?: Date } = {};
  if (s.from) out.createdAfter = new Date(/T/.test(s.from) ? s.from : `${s.from}T00:00:00Z`);
  if (s.to) {
    if (/T/.test(s.to)) out.createdBefore = new Date(s.to);
    else {
      const d = new Date(`${s.to}T00:00:00Z`);
      d.setUTCDate(d.getUTCDate() + 1);
      out.createdBefore = d;
    }
  }
  return out;
}

export interface TaskListFilter {
  createdAfter?: Date;
  createdBefore?: Date;
  taskType?: string[];
  status?: string[];
  priority?: string[];
}

export interface ListPlan {
  /** One ListBacklogTasks walk per filter */
  filters: TaskListFilter[];
  /** Priorities to filter on the client, when the API can't combine them with status */
  clientPriorities: Set<string> | null;
}

/**
 * The API takes one value per filter list, and refuses priority with status
 * unless a task type is also given (ListBacklogTasks API reference). So each
 * combination of values becomes its own call, and when status and priority
 * are both set without a task type, priority is filtered here instead.
 */
export function planListCalls(s: Pick<ExportSelection, "from" | "to" | "taskTypes" | "statuses" | "priorities">): ListPlan {
  const range = dateRange(s);
  const types = s.taskTypes.length ? s.taskTypes : [undefined];
  const statuses = s.statuses.length ? s.statuses : [undefined];
  const clientSide = s.taskTypes.length === 0 && s.statuses.length > 0 && s.priorities.length > 0;
  const priorities = !clientSide && s.priorities.length ? s.priorities : [undefined];
  const filters: TaskListFilter[] = [];
  for (const taskType of uniq(types))
    for (const status of uniq(statuses))
      for (const priority of uniq(priorities)) {
        filters.push({
          ...range,
          ...(taskType ? { taskType: [taskType] } : {}),
          ...(status ? { status: [status] } : {}),
          ...(priority ? { priority: [priority] } : {}),
        });
      }
  return { filters, clientPriorities: clientSide ? new Set(s.priorities) : null };
}

function uniq<T>(xs: T[]): T[] {
  return [...new Set(xs)];
}

/** Split a textarea of IDs on commas, whitespace and newlines. */
export function splitIds(text: string | null | undefined): string[] {
  return [
    ...new Set(
      (text ?? "")
        .split(/[\s,]+/)
        .map((s) => s.trim())
        .filter(Boolean),
    ),
  ];
}

export function describeSelection(s: ExportSelection): string {
  if (s.mode === "taskIds") return `${s.taskIds.length} task ID(s)`;
  const parts: string[] = [];
  if (s.mode === "incidentIds") parts.push(`${s.incidentIds.length} incident ID(s)`);
  if (s.from || s.to) parts.push(`created ${s.from ?? "any time"} to ${s.to ?? "now"}`);
  if (s.taskTypes.length) parts.push(`type ${s.taskTypes.join(", ")}`);
  if (s.statuses.length) parts.push(`status ${s.statuses.join(", ")}`);
  if (s.priorities.length) parts.push(`priority ${s.priorities.join(", ")}`);
  return parts.length ? parts.join("; ") : "all tasks";
}
