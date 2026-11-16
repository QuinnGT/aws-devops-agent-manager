import type { JournalBundle, StoredRecord } from "@/lib/journal/types";
import { lookup, renderTemplate, type RenderHelpers } from "./templates/engine";
import type { TemplateSet } from "./templates/load";

/**
 * Renders cached journals to markdown with the policy's templates. The
 * default templates reproduce the record-created export format:
 *
 *   # Journal Log: <incident>
 *
 *   ---
 *   ## Record: <recordType>
 *   **Created:** <Python datetime>
 *
 *   <body>
 *
 * Pure: no database, filesystem or network.
 */

const MAX_UI_DEPTH = 64;
const MAX_UI_NODES = 20_000;

function helpersFor(t: TemplateSet): RenderHelpers {
  const helpers: RenderHelpers = { truncationNotice: t.markdown.truncationNotice };
  helpers.uiTree = (node) => renderUiTree(node, t, helpers);
  return helpers;
}

/** Each node with text becomes one block, in document order. */
export function renderUiTree(root: unknown, t: TemplateSet, helpers: RenderHelpers = helpersFor(t)): string {
  const blocks: string[] = [];
  let seen = 0;
  const walk = (node: unknown, depth: number) => {
    if (depth > MAX_UI_DEPTH || seen++ > MAX_UI_NODES || node === null || typeof node !== "object") return;
    const type = lookup(node, ["type"]);
    const text = lookup(node, ["text"]);
    if (typeof text === "string" && text !== "") {
      const tpl = (typeof type === "string" && t.ui.nodes.get(type)) || t.ui.fallback;
      blocks.push(renderTemplate(tpl, { text, type: typeof type === "string" ? type : "", props: lookup(node, ["props"]) ?? {} }, helpers));
    }
    const children = lookup(node, ["children"]);
    if (Array.isArray(children)) for (const c of children) walk(c, depth + 1);
  };
  walk(root, 0);
  return blocks.join(t.ui.separator);
}

function recordContext(rec: StoredRecord, t: TemplateSet, helpers: RenderHelpers): Record<string, unknown> {
  const c = rec.content;
  const content = c.kind === "json" ? c.value : c.kind === "markdown" ? (c.json ?? c.text) : c.text;
  const ctx: Record<string, unknown> = {
    recordType: rec.recordType,
    recordId: rec.recordId,
    executionId: rec.executionId,
    taskId: rec.taskId,
    seq: rec.seq,
    createdAt: rec.createdAt,
    kind: c.kind,
    text: c.kind === "json" ? "" : c.text,
    role: c.kind === "markdown" ? (c.role ?? "") : (lookup(content, ["role"]) ?? ""),
    content,
    parts: "",
  };
  const parts = lookup(content, ["content"]);
  if (c.kind === "json" && Array.isArray(parts)) {
    ctx.parts = parts
      .map((part, index) => {
        const type = lookup(part, ["type"]);
        return renderTemplate(t.part(typeof type === "string" ? type : ""), { part, type, index }, helpers);
      })
      .join(t.markdown.partSeparator);
  }
  return ctx;
}

/** The body of one record (no frame). The UI shows this for rendered record types. */
export function renderRecordBody(rec: StoredRecord, t: TemplateSet): string {
  const helpers = helpersFor(t);
  return renderTemplate(t.body(rec.recordType, rec.content.kind), recordContext(rec, t, helpers), helpers);
}

/** One record with its frame. */
export function renderRecord(rec: StoredRecord, t: TemplateSet): string {
  const helpers = helpersFor(t);
  const ctx = recordContext(rec, t, helpers);
  const body = renderTemplate(t.body(rec.recordType, rec.content.kind), ctx, helpers);
  return renderTemplate(t.record, { ...ctx, body }, helpers);
}

/**
 * Records in markdown order: ascending by created time (then execution and
 * position, which keeps the API's order for equal times), reversed for "desc".
 */
export function orderRecordsForMarkdown(bundle: JournalBundle, t: TemplateSet): StoredRecord[] {
  const skip = new Set(t.markdown.skipRecordTypes);
  const execIndex = new Map(bundle.executions.map((e, i) => [e.executionId, i]));
  const asc = bundle.records
    .filter((r) => !skip.has(r.recordType))
    .map((r, i) => ({ r, i }))
    .sort(
      (a, b) =>
        a.r.createdAt.getTime() - b.r.createdAt.getTime() ||
        (execIndex.get(a.r.executionId) ?? 0) - (execIndex.get(b.r.executionId) ?? 0) ||
        a.r.seq - b.r.seq ||
        a.i - b.i,
    )
    .map((x) => x.r);
  return t.markdown.order === "desc" ? asc.reverse() : asc;
}

export function renderJournalMarkdown(bundle: JournalBundle, t: TemplateSet): string {
  const helpers = helpersFor(t);
  const records = orderRecordsForMarkdown(bundle, t)
    .map((r) => renderRecord(r, t))
    .join("");
  const task = bundle.task;
  return renderTemplate(
    t.document,
    {
      incidentId: task.incidentId ?? task.taskId,
      taskId: task.taskId,
      title: task.title ?? "",
      status: task.status ?? "",
      taskType: task.taskType ?? "",
      priority: task.priority ?? "",
      createdAt: task.createdAt,
      executionCount: bundle.executions.length,
      recordCount: bundle.records.length,
      records,
    },
    helpers,
  );
}
