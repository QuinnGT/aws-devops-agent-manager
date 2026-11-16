import { importHeaderOf, importedRecordRawOf, type ImportHeader } from "@/server/journals/markdown-import";
import { parseRecordContent, type JournalBundle, type RecordContent, type StoredRecord, type StoredTask } from "@/lib/journal/types";

/**
 * Normalization layer. Analyzers read journals through this view so that
 * records pulled from the API (content is JSON: {role, content: [blocks]})
 * and records imported from markdown (content is text, sometimes with a
 * fenced JSON block or recovered blocks) look the same.
 *
 * For a message:
 *   text        text blocks and tool-result text, joined by a blank line.
 *               For an imported message without structure, the exported text.
 *   hasText     the message has non-empty text. A markdown export renders
 *               such messages with a role marker; messages without text
 *               (thinking and tool calls only) are exported as JSON.
 *   structured  tool calls and results are known from blocks, not guessed
 * For any other record:
 *   data        the parsed JSON payload, when there is one
 *   text        the markdown or text content (for API JSON, pretty-printed JSON)
 */

export interface NormToolUse {
  id: string | null;
  name: string;
  input: unknown;
  /** False when the export cut the input off and only some keys were recovered */
  inputComplete: boolean;
}

export interface NormToolResult {
  id: string | null;
  status: string | null;
  text: string;
}

export interface NormRecord {
  /** 1-based position in the bundle's ascending order (equals seq for one execution) */
  n: number;
  recordId: string;
  executionId: string;
  seq: number;
  recordType: string;
  createdAt: Date;
  isMessage: boolean;
  role: string | null;
  text: string;
  hasText: boolean;
  textBlocks: string[];
  thinking: string[];
  toolUses: NormToolUse[];
  toolResults: NormToolResult[];
  structured: boolean;
  data: unknown;
  /** Record number shown in the source export, when it had one */
  sourceNumber: number | null;
  /** 1-based line of the record in the imported file, when imported */
  sourceLine: number | null;
}

export interface NormBundle {
  spaceId: string;
  task: StoredTask;
  /** Root execution ID (the task's own execution), when known */
  rootExecutionId: string | null;
  executionIds: string[];
  importHeader: ImportHeader | null;
  records: NormRecord[];
}

const MESSAGE_TYPES = new Set(["message"]);

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => !!v && typeof v === "object" && !Array.isArray(v);

function asContent(c: unknown, raw: unknown): RecordContent {
  if (isObj(c) && (c.kind === "json" || c.kind === "text" || c.kind === "markdown")) return c as unknown as RecordContent;
  if (isObj(raw) && "content" in raw) return parseRecordContent(raw.content);
  return parseRecordContent(c);
}

function textOfResultContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return content === undefined || content === null ? "" : JSON.stringify(content, null, 2);
  const parts: string[] = [];
  for (const item of content) {
    if (typeof item === "string") parts.push(item);
    else if (isObj(item) && typeof item.text === "string") parts.push(item.text);
    else if (isObj(item) && "json" in item) parts.push(JSON.stringify(item.json, null, 2));
    else if (item !== undefined && item !== null) parts.push(JSON.stringify(item, null, 2));
  }
  return parts.join("\n");
}

interface MessageView {
  role: string | null;
  textBlocks: string[];
  thinking: string[];
  toolUses: NormToolUse[];
  toolResults: NormToolResult[];
}

/** Reads API-shaped message content: blocks typed text, thinking, tool_use, tool_result (also toolUse/toolResult keys). */
export function readMessageBlocks(msg: { role?: unknown; content?: unknown }): MessageView {
  const view: MessageView = { role: typeof msg.role === "string" ? msg.role : null, textBlocks: [], thinking: [], toolUses: [], toolResults: [] };
  const blocks = Array.isArray(msg.content) ? msg.content : typeof msg.content === "string" ? [{ type: "text", text: msg.content }] : [];
  for (const b of blocks) {
    if (!isObj(b)) continue;
    const type = typeof b.type === "string" ? b.type : null;
    if (type === "tool_use" || isObj(b.toolUse)) {
      const u = isObj(b.toolUse) ? b.toolUse : b;
      const name = typeof u.tool_name === "string" ? u.tool_name : typeof u.name === "string" ? u.name : "unknown";
      view.toolUses.push({
        id: typeof u.id === "string" ? u.id : typeof u.toolUseId === "string" ? u.toolUseId : null,
        name,
        input: u.input,
        inputComplete: u.input_complete !== false,
      });
    } else if (type === "tool_result" || isObj(b.toolResult)) {
      const r = isObj(b.toolResult) ? b.toolResult : b;
      view.toolResults.push({
        id: typeof r.id === "string" ? r.id : typeof r.toolUseId === "string" ? r.toolUseId : null,
        status: typeof r.status === "string" ? r.status : null,
        text: textOfResultContent(r.content),
      });
    } else if (type === "thinking" || typeof b.thinking === "string") {
      if (typeof b.thinking === "string") view.thinking.push(b.thinking);
    } else if (typeof b.text === "string") {
      view.textBlocks.push(b.text);
    }
  }
  return view;
}

function isMessageObject(v: unknown): v is { role: string; content: unknown[] } {
  return isObj(v) && typeof v.role === "string" && Array.isArray(v.content);
}

function normalizeRecord(r: StoredRecord, n: number): NormRecord {
  const content = asContent(r.content, r.raw);
  const isMessage = MESSAGE_TYPES.has(r.recordType);
  const src = importedRecordRawOf(r.raw);
  const base = {
    n,
    recordId: r.recordId,
    executionId: r.executionId,
    seq: r.seq,
    recordType: r.recordType,
    createdAt: r.createdAt instanceof Date ? r.createdAt : new Date(r.createdAt),
    isMessage,
    sourceNumber: src?.n ?? null,
    sourceLine: src?.line ?? null,
  };
  const empty = { textBlocks: [] as string[], thinking: [] as string[], toolUses: [] as NormToolUse[], toolResults: [] as NormToolResult[] };

  if (isMessage) {
    const structuredValue = content.kind === "json" ? content.value : content.kind === "markdown" ? content.json : undefined;
    if (isMessageObject(structuredValue)) {
      const v = readMessageBlocks(structuredValue);
      const role = v.role ?? (content.kind === "markdown" ? (content.role ?? null) : null);
      const parts = [...v.textBlocks, ...v.toolResults.map((t) => t.text)];
      const text = parts.join("\n\n");
      return { ...base, ...v, role, text, hasText: parts.some((p) => p.trim().length > 0), structured: true, data: null };
    }
    const text = content.kind === "json" ? JSON.stringify(content.value, null, 2) : content.text;
    const role = content.kind === "markdown" ? (content.role ?? null) : null;
    return { ...base, ...empty, role, text, hasText: text.trim().length > 0, textBlocks: text ? [text] : [], structured: false, data: null };
  }

  if (content.kind === "json") {
    return { ...base, ...empty, role: null, text: JSON.stringify(content.value, null, 2), hasText: true, structured: false, data: content.value };
  }
  if (content.kind === "markdown") {
    return { ...base, ...empty, role: content.role ?? null, text: content.text, hasText: content.text.trim().length > 0, structured: false, data: content.json ?? null };
  }
  // Plain text content that is a JSON document is still data (API records whose content is a JSON string)
  return { ...base, ...empty, role: null, text: content.text, hasText: content.text.trim().length > 0, structured: false, data: null };
}

/** Orders records ascending by time, then by the execution order given, then by seq. */
export function normalizeBundle(bundle: JournalBundle): NormBundle {
  const execOrder = new Map(bundle.executions.map((e, i) => [e.executionId, i]));
  const time = (r: StoredRecord) => (r.createdAt instanceof Date ? r.createdAt.getTime() : new Date(r.createdAt).getTime());
  const sorted = [...bundle.records].sort(
    (a, b) =>
      time(a) - time(b) ||
      (execOrder.get(a.executionId) ?? Number.MAX_SAFE_INTEGER) - (execOrder.get(b.executionId) ?? Number.MAX_SAFE_INTEGER) ||
      a.seq - b.seq,
  );
  const taskRaw = bundle.task.raw as { executionId?: unknown } | null;
  const root =
    bundle.executions.find((e) => !e.parentExecutionId)?.executionId ??
    (typeof taskRaw?.executionId === "string" ? taskRaw.executionId : null) ??
    bundle.executions[0]?.executionId ??
    null;
  return {
    spaceId: bundle.spaceId,
    task: bundle.task,
    rootExecutionId: root,
    executionIds: bundle.executions.map((e) => e.executionId),
    importHeader: importHeaderOf(bundle.task.raw) ?? importHeaderOf(bundle.executions[0]?.raw),
    records: sorted.map((r, i) => normalizeRecord(r, i + 1)),
  };
}

/** Python-style splitlines(): splits on the same line boundaries Python 3 str.splitlines() uses. */
export function pySplitLines(s: string): string[] {
  if (!s) return [];
  const out = s.split(/\r\n|[\n\r\v\f\x1c\x1d\x1e\x85\u2028\u2029]/);
  if (out.length && out[out.length - 1] === "") out.pop();
  return out;
}

/** Length in Unicode code points (Python len() on str). */
export function cpLength(s: string): number {
  let n = 0;
  for (const _ of s) n++;
  return n;
}

/** First `n` code points (Python s[:n]). */
export function cpSlice(s: string, n: number): string {
  if (s.length <= n) return s;
  let out = "";
  let i = 0;
  for (const ch of s) {
    if (i++ >= n) break;
    out += ch;
  }
  return out;
}
