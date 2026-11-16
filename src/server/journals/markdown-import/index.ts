import { createHash } from "node:crypto";
import type { Policy } from "@/server/policy";
import type { JournalImportFormat } from "@/server/policy/sections/journal-import";
import type { RecordContent, StoredExecution, StoredRecord, StoredTask } from "@/lib/journal/types";
import { compileBlockPatterns, recoverBlocks, type RecoveredBlock } from "./blocks";
import { parseExportTimestamp } from "./time";

/**
 * CONTRACT. Parses one markdown journal export into canonical shapes. The
 * journals module calls this from its import job; it must stay pure (no DB, no filesystem, no network).
 *
 * The existing exports use two formats:
 *  1. "## Record: <recordType>" followed by a "**Created:**" line
 *  2. a numbered heading "## Record <n> — <type> (<UTC time>+00:00)"
 * Heading patterns come from policy (journal-import.yaml), not code.
 *
 * What the parser recovers per record (RecordContent kind "markdown"):
 *  - text: the record body without its heading, created line, role marker and
 *    trailing separator, with leading blank lines and trailing whitespace removed
 *  - role: from the format's role marker, or from the JSON when a message was
 *    exported as its JSON content
 *  - json: the parsed value when the body is one fenced JSON block; for
 *    formats with tool call and result patterns, a recovered message
 *    `{ role, content: [blocks], recovered: "markdown" }` in the API block shape
 *
 * IDs: recordId is sha256("<sourceSha256>:<seq>"). The execution ID is the one
 * in the document header when present, else "import-<first 32 hex of the source SHA>".
 * The task ID is "import-<execution ID from the header>" or "import-<first 32 hex>".
 * seq is the position in ascending time order (ties keep the export's order).
 */

export interface ParsedMarkdownJournal {
  /** Format id from policy that matched */
  format: string;
  task: Omit<StoredTask, "source" | "raw"> & { raw: unknown };
  executions: StoredExecution[];
  /** recordId is synthesized deterministically (sha256 of source sha + seq) when absent */
  records: StoredRecord[];
  warnings: string[];
}

export interface ParseOptions {
  /** SHA-256 of the source file, used to synthesize stable IDs */
  sourceSha256: string;
  fileName: string;
  /** Incident ID if known from the file or folder name (e.g. INCIDENT-31744) */
  incidentIdHint?: string | null;
  /** Use this format id from policy instead of detecting one */
  format?: string;
}

/** The input could not be parsed at all (no configured format matched). */
export class MarkdownImportError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MarkdownImportError";
  }
}

/** Fields read from the document header (text before the first record). */
export interface ImportHeader {
  incident: string | null;
  execution: string | null;
  /** Record count the exporter stated, if any */
  records: number | null;
  pages: number | null;
}

/** `raw` on imported tasks and executions. */
export interface ImportedTaskRaw {
  kind: "markdown-import";
  format: string;
  fileName: string;
  sourceSha256: string;
  header: ImportHeader;
  recordCount: number;
}

/** `raw` on imported records: where the record came from, and its source block. */
export interface ImportedRecordRaw {
  kind: "markdown-import";
  format: string;
  /** Record number from the heading, when the format has one */
  n: number | null;
  /** 1-based line of the heading in the source file */
  line: number;
  heading: string;
  /** The record exactly as it appears in the source, heading included */
  block: string;
}

/** Reads the import header from a task's or execution's `raw`, or null for API journals. */
export function importHeaderOf(raw: unknown): ImportHeader | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Partial<ImportedTaskRaw>;
  if (r.kind !== "markdown-import" || !r.header || typeof r.header !== "object") return null;
  return r.header;
}

/** Reads an imported record's source info from `raw`, or null for API records. */
export function importedRecordRawOf(raw: unknown): ImportedRecordRaw | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Partial<ImportedRecordRaw>;
  return r.kind === "markdown-import" && typeof r.line === "number" ? (r as ImportedRecordRaw) : null;
}

const LEADING_BLANK_LINES = /^(?:[ \t]*\n)+/;
const WHOLE_JSON_FENCE = /^```json[ \t]*\n([\s\S]*)\n```$/;

function sha256Hex(s: string): string {
  return createHash("sha256").update(s).digest("hex");
}

function lineStarts(text: string): number[] {
  const out = [0];
  for (let i = text.indexOf("\n"); i !== -1; i = text.indexOf("\n", i + 1)) out.push(i + 1);
  return out;
}

function lineOf(starts: number[], offset: number): number {
  let lo = 0;
  let hi = starts.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (starts[mid]! <= offset) lo = mid;
    else hi = mid - 1;
  }
  return lo + 1;
}

/** Match `re` on the first non-blank line of `body`; returns the match and the rest of the body. */
function takeFirstLine(body: string, source: string | undefined): { groups: Record<string, string | undefined>; rest: string } | null {
  if (!source) return null;
  const skip = LEADING_BLANK_LINES.exec(body)?.[0].length ?? 0;
  const re = new RegExp(source, "my");
  re.lastIndex = skip;
  const m = re.exec(body);
  if (!m) return null;
  return { groups: m.groups ?? {}, rest: body.slice(m.index + m[0].length) };
}

function dropTrailingSeparator(body: string, source: string | undefined): string {
  const trimmed = body.replace(/\s+$/, "");
  if (!source) return trimmed;
  const nl = trimmed.lastIndexOf("\n");
  const last = trimmed.slice(nl + 1);
  const re = new RegExp(`(?:${source})`, "m");
  const m = re.exec(last);
  if (m && m.index === 0 && m[0].length === last.trimEnd().length) return trimmed.slice(0, Math.max(nl, 0));
  return trimmed;
}

function cleanText(body: string): string {
  return body.replace(LEADING_BLANK_LINES, "").replace(/\s+$/, "");
}

function isMessageObject(v: unknown): v is { role: string; content: unknown[] } {
  return !!v && typeof v === "object" && typeof (v as { role?: unknown }).role === "string" && Array.isArray((v as { content?: unknown }).content);
}

function toInt(s: string | undefined): number | null {
  if (s === undefined || !/^\d+$/.test(s)) return null;
  return Number(s);
}

function chooseFormat(text: string, formats: JournalImportFormat[]): { format: JournalImportFormat; headings: RegExpExecArray[] } | null {
  let best: { format: JournalImportFormat; headings: RegExpExecArray[] } | null = null;
  for (const f of formats) {
    const re = new RegExp(f.recordHeading, "gm");
    const headings = [...text.matchAll(re)].filter((m) => m[0].length > 0) as RegExpExecArray[];
    if (headings.length && (!best || headings.length > best.headings.length)) best = { format: f, headings };
  }
  return best;
}

interface Draft {
  fileIndex: number;
  n: number | null;
  recordType: string;
  createdAt: Date | null;
  content: RecordContent;
  raw: ImportedRecordRaw;
}

export function parseJournalMarkdown(input: string, policy: Pick<Policy, "journalImport">, opts: ParseOptions): ParsedMarkdownJournal {
  if (!/^[0-9a-f]{64}$/i.test(opts.sourceSha256)) throw new MarkdownImportError("sourceSha256 must be a SHA-256 hex digest");
  const sourceSha = opts.sourceSha256.toLowerCase();
  const text = input.replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n");
  const all = policy.journalImport.formats;
  const candidates = opts.format ? all.filter((f) => f.id === opts.format) : all;
  if (opts.format && candidates.length === 0) throw new MarkdownImportError(`Unknown journal import format: ${opts.format}`);
  if (candidates.length === 0) throw new MarkdownImportError("No journal import formats are configured (policy journal-import.yaml)");

  const chosen = chooseFormat(text, candidates);
  if (!chosen) {
    throw new MarkdownImportError(
      `No record headings found in ${opts.fileName}. Configured formats: ${candidates.map((f) => f.id).join(", ")}`,
    );
  }
  const { format, headings } = chosen;
  const warnings: string[] = [];
  const starts = lineStarts(text);
  const blockPatterns = compileBlockPatterns(format);
  const messageTypes = new Set(format.messageTypes);

  // Document header
  const headerText = text.slice(0, headings[0]!.index);
  const header: ImportHeader = { incident: null, execution: null, records: null, pages: null };
  if (format.documentHeader) {
    const m = new RegExp(format.documentHeader, "m").exec(headerText);
    if (m?.groups) {
      header.incident = m.groups.incident?.trim() || null;
      header.execution = m.groups.execution?.trim() || null;
      header.records = toInt(m.groups.records);
      header.pages = toInt(m.groups.pages);
    } else {
      warnings.push("The document header did not match the format's header pattern");
    }
  }

  const drafts: Draft[] = [];
  let subMs = 0;
  headings.forEach((h, i) => {
    const start = h.index;
    const end = i + 1 < headings.length ? headings[i + 1]!.index : text.length;
    const line = lineOf(starts, start);
    const g = h.groups ?? {};
    const recordType = g.type?.trim() || "unknown";
    if (!g.type) warnings.push(`Record at line ${line} has no type`);
    let body = text.slice(start + h[0].length, end);
    let timeStr = g.time;

    const created = takeFirstLine(body, format.createdLine);
    if (created) {
      timeStr ??= created.groups.time;
      body = created.rest;
    } else if (format.createdLine) {
      warnings.push(`Record at line ${line} has no created line`);
    }
    body = dropTrailingSeparator(body, format.recordSeparator);

    let role: string | null = null;
    if (messageTypes.has(recordType)) {
      const r = takeFirstLine(body, format.roleLine);
      if (r) {
        role = r.groups.role?.trim() || null;
        body = r.rest;
      }
    }
    const recText = cleanText(body);

    let json: unknown = undefined;
    const fence = WHOLE_JSON_FENCE.exec(recText);
    if (fence && !fence[1]!.includes("\n```")) {
      try {
        json = JSON.parse(fence[1]!);
      } catch {
        warnings.push(`Record at line ${line} has a JSON block that does not parse`);
      }
      if (messageTypes.has(recordType) && isMessageObject(json)) role ??= json.role;
    } else if (blockPatterns && messageTypes.has(recordType)) {
      const blocks: RecoveredBlock[] | null = recoverBlocks(recText, blockPatterns);
      if (blocks) json = { role, content: blocks, recovered: "markdown" };
    }

    let createdAt: Date | null = null;
    if (timeStr) {
      const t = parseExportTimestamp(timeStr);
      if (t) {
        createdAt = t.date;
        if (t.subMillisecondDropped) subMs++;
      } else {
        warnings.push(`Record at line ${line} has a time that does not parse: ${timeStr}`);
      }
    } else {
      warnings.push(`Record at line ${line} has no time`);
    }

    const content: RecordContent = json === undefined ? { kind: "markdown", text: recText, role } : { kind: "markdown", text: recText, role, json };
    drafts.push({
      fileIndex: i,
      n: toInt(g.n),
      recordType,
      createdAt,
      content,
      raw: {
        kind: "markdown-import",
        format: format.id,
        n: toInt(g.n),
        line,
        heading: h[0],
        block: text.slice(start, end).replace(/\s+$/, ""),
      },
    });
  });
  if (subMs) warnings.push(`${subMs} record time(s) had digits below one millisecond; they were dropped`);

  // Records without a time take the previous record's time (in export order), so ordering stays stable.
  let lastTime: Date | null = null;
  for (const d of drafts) {
    if (d.createdAt) lastTime = d.createdAt;
    else d.createdAt = lastTime ?? new Date(0);
  }

  // Ascending time order. Ties keep the export's order: by record number when the format has one,
  // otherwise by file position.
  const sorted = [...drafts].sort((a, b) => {
    const dt = a.createdAt!.getTime() - b.createdAt!.getTime();
    if (dt) return dt;
    if (a.n !== null && b.n !== null && a.n !== b.n) return a.n - b.n;
    return a.fileIndex - b.fileIndex;
  });

  const numbers = drafts.map((d) => d.n).filter((n): n is number => n !== null);
  if (numbers.length) {
    if (new Set(numbers).size !== numbers.length) warnings.push("Some record numbers appear more than once");
    const inOrder = sorted.every((d, i) => i === 0 || d.n === null || sorted[i - 1]!.n === null || d.n > sorted[i - 1]!.n!);
    if (!inOrder) warnings.push("Record numbers are not in time order; seq follows time");
  }
  if (header.records !== null && header.records !== drafts.length) {
    warnings.push(`The header lists ${header.records} records but ${drafts.length} were found`);
  }

  const idPart = sourceSha.slice(0, 32);
  const executionId = header.execution ?? `import-${idPart}`;
  const taskId = `import-${header.execution ?? idPart}`;
  const records: StoredRecord[] = sorted.map((d, i) => ({
    recordId: sha256Hex(`${sourceSha}:${i + 1}`),
    executionId,
    taskId,
    seq: i + 1,
    recordType: d.recordType,
    createdAt: d.createdAt!,
    content: d.content,
    raw: d.raw,
  }));

  let title: string | null = null;
  if (format.title) title = new RegExp(format.title, "m").exec(text)?.groups?.title?.trim() || null;
  const startAt = records[0]!.createdAt;
  const endAt = records[records.length - 1]!.createdAt;
  const taskRaw: ImportedTaskRaw = {
    kind: "markdown-import",
    format: format.id,
    fileName: opts.fileName,
    sourceSha256: sourceSha,
    header,
    recordCount: records.length,
  };

  return {
    format: format.id,
    task: {
      taskId,
      incidentId: header.incident ?? opts.incidentIdHint ?? null,
      title,
      description: null,
      taskType: null,
      status: null,
      priority: null,
      reference: null,
      createdAt: startAt,
      updatedAt: endAt,
      raw: taskRaw,
    },
    executions: [
      {
        executionId,
        taskId,
        parentExecutionId: null,
        agentType: null,
        agentSubTask: null,
        status: null,
        createdAt: startAt,
        updatedAt: endAt,
        raw: taskRaw,
      },
    ],
    records,
    warnings,
  };
}
