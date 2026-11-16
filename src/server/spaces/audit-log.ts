import { and, asc, desc, eq, gte, ilike, inArray, lt, or, type SQL, sql } from "drizzle-orm";
import { db } from "@/server/db/client";
import { agentSpaces, auditEvents, plans } from "@/server/db/schema";
import { type AuditFilter, zonedDayStart } from "./audit-filter";
import { csvLine } from "./csv";

/**
 * Reading and exporting the audit log (append-only, exportable as CSV or
 * JSON). Writing stays in src/server/audit-log.
 */

/** What the caller may read: everything (global auditlog.read) or only some spaces' events. */
export type AuditScope = { all: true } | { all: false; spaceIds: string[] };

/**
 * Build the caller's scope: global permission reads every event; otherwise
 * only events of spaces where the caller has auditlog.read. Null when the
 * caller may read nothing.
 */
export async function resolveAuditScope(
  spaceIds: string[],
  canRead: (spaceId: string | null) => Promise<boolean>,
): Promise<AuditScope | null> {
  if (await canRead(null)) return { all: true };
  const allowed: string[] = [];
  for (const id of spaceIds) if (await canRead(id)) allowed.push(id);
  return allowed.length > 0 ? { all: false, spaceIds: allowed } : null;
}

export { auditFilterSchema, type AuditFilter } from "./audit-filter";

/** Options for reading events: the zone the `from` and `to` days are in (UTC by default). */
export interface AuditReadOptions {
  timeZone?: string;
}

export interface AuditEventView {
  id: number;
  at: Date;
  actorEmail: string;
  actorName: string | null;
  action: string;
  spaceId: string | null;
  spaceAlias: string | null;
  targetType: string | null;
  targetId: string | null;
  result: "ok" | "error" | "denied";
  details: unknown;
  /** The plan's title when the target is a plan this app still has, for events whose details don't name it (plan.check) */
  planTitle?: string | null;
}

function escapeLike(s: string): string {
  return s.replace(/[\\%_]/g, (c) => `\\${c}`);
}

function conditions(filter: AuditFilter, scope: AuditScope, opts: AuditReadOptions = {}): SQL[] {
  const zone = opts.timeZone ?? "UTC";
  const c: SQL[] = [];
  if (!scope.all) c.push(inArray(auditEvents.spaceId, scope.spaceIds));
  if (filter.space?.length) c.push(inArray(auditEvents.spaceId, filter.space));
  if (filter.action?.length) c.push(inArray(auditEvents.action, filter.action));
  if (filter.result?.length) c.push(inArray(auditEvents.result, filter.result));
  if (filter.actor) {
    const like = `%${escapeLike(filter.actor)}%`;
    c.push(or(ilike(auditEvents.actorEmail, like), ilike(auditEvents.actorName, like))!);
  }
  if (filter.target) {
    const like = `%${escapeLike(filter.target)}%`;
    c.push(
      or(
        ilike(auditEvents.targetType, like),
        ilike(auditEvents.targetId, like),
        and(inArray(auditEvents.targetType, ["agent_space", "space"]), ilike(agentSpaces.alias, like)),
        sql`${auditEvents.details}->>'name' ilike ${like}`,
        sql`${auditEvents.details}->>'title' ilike ${like}`,
        sql`${auditEvents.details}->>'alias' ilike ${like}`,
        sql`${auditEvents.details}->>'subject' ilike ${like}`,
        ilike(plans.title, like),
      )!,
    );
  }
  if (filter.from) c.push(gte(auditEvents.at, zonedDayStart(filter.from, zone)));
  if (filter.to) c.push(lt(auditEvents.at, zonedDayStart(filter.to, zone, 1)));
  if (filter.before) c.push(lt(auditEvents.id, filter.before));
  return c;
}

/** Newest first, at most `limit` events. */
export async function queryAuditEvents(filter: AuditFilter, scope: AuditScope, limit: number, opts: AuditReadOptions = {}): Promise<AuditEventView[]> {
  const rows = await db()
    .select({ e: auditEvents, alias: agentSpaces.alias, planTitle: plans.title })
    .from(auditEvents)
    .leftJoin(agentSpaces, eq(auditEvents.spaceId, agentSpaces.id))
    // Same space only, so a plan ID can't surface another space's plan title.
    .leftJoin(plans, and(eq(auditEvents.targetType, "plan"), eq(sql`${plans.id}::text`, auditEvents.targetId), eq(plans.spaceId, auditEvents.spaceId)))
    .where(and(...conditions(filter, scope, opts)))
    .orderBy(desc(auditEvents.id))
    .limit(limit);
  return rows.map(({ e, alias, planTitle }) => ({ ...e, spaceAlias: alias, planTitle }));
}

/** Every matching event, newest first, read in batches. */
export async function* iterateAuditEvents(filter: AuditFilter, scope: AuditScope, batchSize = 1000, opts: AuditReadOptions = {}): AsyncGenerator<AuditEventView> {
  let before = filter.before;
  for (;;) {
    const batch = await queryAuditEvents({ ...filter, before }, scope, batchSize, opts);
    for (const e of batch) yield e;
    if (batch.length < batchSize) return;
    before = batch[batch.length - 1]!.id;
  }
}

/** Distinct action names visible in the scope, for the filter list. */
export async function listAuditActions(scope: AuditScope): Promise<string[]> {
  const rows = await db()
    .selectDistinct({ action: auditEvents.action })
    .from(auditEvents)
    .where(scope.all ? sql`true` : inArray(auditEvents.spaceId, scope.spaceIds))
    .orderBy(asc(auditEvents.action));
  return rows.map((r) => r.action);
}

export const AUDIT_CSV_COLUMNS = [
  "id",
  "at",
  "actor_email",
  "actor_name",
  "action",
  "space_id",
  "space_alias",
  "target_type",
  "target_id",
  "result",
  "details",
] as const;

export function auditEventCsvLine(e: AuditEventView): string {
  return csvLine([e.id, e.at, e.actorEmail, e.actorName, e.action, e.spaceId, e.spaceAlias, e.targetType, e.targetId, e.result, e.details]);
}

export function auditEventJson(e: AuditEventView): Record<string, unknown> {
  return {
    id: e.id,
    at: e.at.toISOString(),
    actorEmail: e.actorEmail,
    actorName: e.actorName,
    action: e.action,
    spaceId: e.spaceId,
    spaceAlias: e.spaceAlias,
    targetType: e.targetType,
    targetId: e.targetId,
    result: e.result,
    details: e.details ?? null,
  };
}

/** The whole export as a byte stream: CSV with a header row, or a JSON array. */
export function auditExportStream(format: "csv" | "json", filter: AuditFilter, scope: AuditScope, opts: AuditReadOptions = {}): ReadableStream<Uint8Array> {
  const enc = new TextEncoder();
  const it = iterateAuditEvents(filter, scope, 1000, opts);
  let first = true;
  let done = false;
  return new ReadableStream<Uint8Array>({
    async start(controller) {
      controller.enqueue(enc.encode(format === "csv" ? csvLine(AUDIT_CSV_COLUMNS) : "["));
    },
    async pull(controller) {
      if (done) return;
      const chunk: string[] = [];
      for (let i = 0; i < 200; i++) {
        const next = await it.next();
        if (next.done) {
          done = true;
          break;
        }
        if (format === "csv") chunk.push(auditEventCsvLine(next.value));
        else {
          chunk.push(`${first ? "\n" : ",\n"}${JSON.stringify(auditEventJson(next.value))}`);
          first = false;
        }
      }
      if (chunk.length) controller.enqueue(enc.encode(chunk.join("")));
      if (done) {
        if (format === "json") controller.enqueue(enc.encode(first ? "]\n" : "\n]\n"));
        controller.close();
      }
    },
    async cancel() {
      await it.return(undefined);
    },
  });
}
