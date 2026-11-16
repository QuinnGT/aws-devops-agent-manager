import vm from "node:vm";
import { tool, type ToolSet } from "ai";
import { z } from "zod";
import type { NormBundle, NormRecord } from "@/server/analyzers/normalize";
import { block } from "./blocks";
import { recordTexts, utcTime } from "./records";

/**
 * The reviewer's tools: read-only views of one investigation's records (the
 * bundle passed in) and nothing else. Every result is capped at `capChars`
 * and says when and where it was cut. Bad input (a record out of range, an
 * invalid or runaway regular expression) comes back to the model as a message.
 */

export const SEARCH_DEFAULT_LIMIT = 20;
export const SEARCH_MAX_LIMIT = 50;
export const RANGE_MAX_RECORDS = 50;
const SNIPPET_RADIUS = 100;
const MATCHES_PER_RECORD = 3;
const MAX_PATTERN_CHARS = 500;
/** A regular expression from the model runs in a VM context with this timeout, so catastrophic backtracking cannot stall the worker. */
export const REGEX_TIMEOUT_MS = 2000;

function attrs(r: NormRecord) {
  return { n: r.n, type: r.recordType, role: r.role, time: utcTime(r.createdAt) };
}

function label(r: NormRecord): string {
  return `R${r.n} ${r.recordType}${r.role ? ` ${r.role}` : ""} ${utcTime(r.createdAt)}`;
}

type Span = [number, number];

/**
 * A <record> block holding text[offset..] cut so the whole block fits in `max`
 * characters (neutralized tags make the block longer than the raw text).
 */
function recordBlockWithin(r: NormRecord, text: string, offset: number, max: number, wantedEnd = text.length): { block: string; end: number } {
  let end = Math.min(text.length, wantedEnd, offset + Math.max(0, max));
  for (let i = 0; i < 5; i++) {
    const shown = offset === 0 && end === text.length ? undefined : `${offset}-${end} of ${text.length} characters`;
    const b = block("record", text.slice(offset, end), { ...attrs(r), shown });
    if (b.length <= max || end <= offset) return { block: b, end };
    end = Math.max(offset, end - (b.length - max));
  }
  return { block: block("record", "", { ...attrs(r), shown: `${offset}-${offset} of ${text.length} characters` }), end: offset };
}

/** Matches of `query` in each text: up to MATCHES_PER_RECORD spans each. Throws for an invalid pattern or a timeout. */
function regexSpans(texts: string[], pattern: string, flags: string): Span[][] {
  new RegExp(pattern, flags); // syntax errors surface here, outside the VM, with a normal message
  const ctx = vm.createContext({ texts, pattern, flags, perRecord: MATCHES_PER_RECORD });
  const code = `(() => {
    const re = new RegExp(pattern, flags);
    return texts.map((t) => {
      const out = [];
      re.lastIndex = 0;
      let m;
      while (out.length < perRecord && (m = re.exec(t)) !== null) {
        out.push([m.index, m.index + m[0].length]);
        if (m[0].length === 0) re.lastIndex++;
      }
      return out;
    });
  })()`;
  const result = vm.runInContext(code, ctx, { timeout: REGEX_TIMEOUT_MS }) as Span[][];
  // Copy out of the VM realm so callers get plain arrays
  return result.map((spans) => spans.map(([a, b]) => [a, b] as Span));
}

function textSpans(texts: string[], query: string, caseSensitive: boolean): Span[][] {
  const q = caseSensitive ? query : query.toLowerCase();
  return texts.map((t) => {
    const hay = caseSensitive ? t : t.toLowerCase();
    const out: Span[] = [];
    let i = hay.indexOf(q);
    while (i >= 0 && out.length < MATCHES_PER_RECORD) {
      out.push([i, i + q.length]);
      i = hay.indexOf(q, i + Math.max(q.length, 1));
    }
    return out;
  });
}

function snippet(text: string, [a, b]: Span): string {
  const from = Math.max(0, a - SNIPPET_RADIUS);
  const to = Math.min(text.length, b + SNIPPET_RADIUS);
  return `${from > 0 ? "…" : ""}${text.slice(from, to)}${to < text.length ? "…" : ""}`.replace(/\s+/g, " ").trim();
}

/** Lines inside a block, added while they fit in `cap` (with room for the closing note). */
function fitLines(header: string, lines: string[], footer: (shown: number) => string, cap: number, tag: "search_results" | "records"): string {
  const shell = (body: string[], shown: number) => {
    const foot = footer(shown);
    return `${header}\n${block(tag, body.join("\n"))}${foot ? `\n${foot}` : ""}`;
  };
  const body: string[] = [];
  for (const line of lines) {
    if (shell([...body, line], body.length + 1).length > cap) break;
    body.push(line);
  }
  return shell(body, body.length).slice(0, cap);
}

export interface SearchArgs {
  query: string;
  regex?: boolean;
  caseSensitive?: boolean;
  recordTypes?: string[];
  limit?: number;
}

export function searchRecords(bundle: NormBundle, args: SearchArgs, cap: number): string {
  const query = args.query ?? "";
  if (!query.trim()) return "The query is empty. Give a word, phrase or regular expression to search for.";
  if (query.length > MAX_PATTERN_CHARS) return `The query is longer than ${MAX_PATTERN_CHARS} characters. Use a shorter one.`;
  const limit = Math.min(Math.max(1, Math.trunc(args.limit ?? SEARCH_DEFAULT_LIMIT)), SEARCH_MAX_LIMIT);
  const types = args.recordTypes?.length ? new Set(args.recordTypes) : null;
  const all = recordTexts(bundle);
  const candidates = bundle.records.filter((r) => !types || types.has(r.recordType));
  const texts = candidates.map((r) => all[r.n - 1] ?? "");

  let spans: Span[][];
  if (args.regex) {
    try {
      spans = regexSpans(texts, query, `gm${args.caseSensitive ? "" : "i"}`);
    } catch (e) {
      const code = (e as { code?: string }).code;
      if (code === "ERR_SCRIPT_EXECUTION_TIMEOUT") {
        return `The regular expression took longer than ${REGEX_TIMEOUT_MS / 1000} seconds and was stopped. Use a simpler pattern, or a plain text search (regex: false).`;
      }
      return `The regular expression is not valid: ${e instanceof Error ? e.message : String(e)}. Fix the pattern, or search as plain text (regex: false).`;
    }
  } else {
    spans = textSpans(texts, query, args.caseSensitive ?? false);
  }

  const hits = candidates.map((r, i) => ({ r, text: texts[i]!, spans: spans[i]! })).filter((h) => h.spans.length > 0);
  const scope = types ? ` in record types ${[...types].join(", ")}` : "";
  const header = `Search for ${JSON.stringify(query)} (${args.regex ? "regular expression" : "text"}${args.caseSensitive ? ", case-sensitive" : ""})${scope}: ${hits.length} of ${candidates.length} records match.`;
  if (!hits.length) {
    const known = [...new Set(bundle.records.map((r) => r.recordType))].sort().join(", ");
    return `${header}${types ? ` Record types in this journal: ${known}.` : ""}`;
  }
  const listed = hits.slice(0, limit);
  const lines = listed.map((h) => `${label(h.r)}: ${h.spans.map((s) => snippet(h.text, s)).join(" | ")}`);
  const footer = (shown: number) => {
    const notes: string[] = [];
    if (shown < listed.length) notes.push(`[Result cut at ${cap} characters: ${listed.length - shown} more of the listed matches are not shown.]`);
    if (hits.length > limit) notes.push(`[Showing the first ${limit} of ${hits.length} matching records. Narrow the search, filter by record type, or raise the limit (up to ${SEARCH_MAX_LIMIT}).]`);
    if (shown > 0 && hits.length > 0) notes.push("Read a record in full with read_record.");
    return notes.join("\n");
  };
  return fitLines(header, lines, footer, cap, "search_results");
}

function outOfRange(bundle: NormBundle, n: number): string | null {
  const count = bundle.records.length;
  if (!Number.isInteger(n) || n < 1 || n > count) return `There is no record R${n}. This journal has records R1 to R${count}.`;
  return null;
}

export function readRecords(bundle: NormBundle, args: { from: number; to: number }, cap: number): string {
  const count = bundle.records.length;
  if (!count) return "This journal has no records.";
  const bad = outOfRange(bundle, args.from);
  if (bad) return bad;
  if (!Number.isInteger(args.to) || args.to < args.from) return `"to" must be a record number from R${args.from} to R${count}.`;
  const to = Math.min(args.to, count, args.from + RANGE_MAX_RECORDS - 1);
  const texts = recordTexts(bundle);
  const header = `Records R${args.from} to R${to} of ${count}.`;
  const reserve = 450; // room for the notes at the end
  const budget = cap - header.length - reserve;
  const out: string[] = [];
  let used = 0;
  let next = args.from;
  let note = "";
  for (let n = args.from; n <= to; n++) {
    const r = bundle.records[n - 1]!;
    const text = texts[n - 1] ?? "";
    const full = block("record", text, attrs(r));
    if (used + full.length + 1 <= budget) {
      out.push(full);
      used += full.length + 1;
      next = n + 1;
      continue;
    }
    const room = budget - used - 1;
    if (room > 500) {
      const part = recordBlockWithin(r, text, 0, room);
      out.push(part.block);
      note = `[R${n} is cut after ${part.end} of ${text.length} characters. Read the rest with read_record n=${n} offset=${part.end}.]`;
      next = n + 1;
    }
    break;
  }
  const notes: string[] = [];
  if (note) notes.push(note);
  if (next <= to) notes.push(`[Result cut at ${cap} characters: R${next} to R${to} are not shown. Call read_records with from=${next}.]`);
  if (to < args.to) notes.push(`[At most ${RANGE_MAX_RECORDS} records per call${args.to > count ? `, and the journal ends at R${count}` : ""}: call again with from=${to + 1} for more.]`);
  return [header, ...out, ...notes].join("\n");
}

export function readRecord(bundle: NormBundle, args: { n: number; offset?: number; length?: number }, cap: number): string {
  const bad = outOfRange(bundle, args.n);
  if (bad) return bad;
  const r = bundle.records[args.n - 1]!;
  const text = recordTexts(bundle)[args.n - 1] ?? "";
  const offset = Math.max(0, Math.trunc(args.offset ?? 0));
  if (offset > 0 && offset >= text.length) return `R${args.n} has ${text.length} characters, so offset ${offset} is past its end.`;
  const reserve = 200; // room for the continuation note
  const room = Math.max(300, cap - reserve);
  const wanted = Math.max(1, Math.trunc(args.length ?? room));
  const part = recordBlockWithin(r, text, offset, room, offset + wanted);
  const end = part.end;
  const more = end < text.length ? `\n[R${args.n} continues: ${text.length - end} more characters. Call read_record with n=${args.n} offset=${end}.]` : "";
  return `${part.block}${more}`;
}

/** The three tools, bound to one bundle. */
export function reviewTools(bundle: NormBundle, capChars: number) {
  return {
    search_records: tool({
      description:
        "Search this investigation's journal records for text or a regular expression. Returns matching record numbers with short snippets around each match. " +
        "Use it to find where a service, error, hypothesis or human message appears.",
      inputSchema: z.object({
        query: z.string().describe("Text to find, or a JavaScript regular expression when regex is true"),
        regex: z.boolean().optional().describe("Treat query as a regular expression (default false)"),
        caseSensitive: z.boolean().optional().describe("Match case exactly (default false)"),
        recordTypes: z.array(z.string()).max(20).optional().describe("Only search these record types, e.g. message, finding, investigation_summary_md"),
        limit: z.number().int().min(1).max(SEARCH_MAX_LIMIT).optional().describe(`Most records to list (default ${SEARCH_DEFAULT_LIMIT})`),
      }),
      execute: async (args) => searchRecords(bundle, args, capChars),
    }),
    read_records: tool({
      description: `Read a range of records in full, in order (at most ${RANGE_MAX_RECORDS} per call; long results are cut and say where to continue).`,
      inputSchema: z.object({
        from: z.number().int().min(1).describe("First record number"),
        to: z.number().int().min(1).describe("Last record number (inclusive)"),
      }),
      execute: async (args) => readRecords(bundle, args, capChars),
    }),
    read_record: tool({
      description: "Read one record. For a long record, pass an offset (in characters) to continue where an earlier result was cut.",
      inputSchema: z.object({
        n: z.number().int().min(1).describe("Record number"),
        offset: z.number().int().min(0).optional().describe("Character offset to start at (default 0)"),
        length: z.number().int().min(1).optional().describe("Characters to return (default and maximum: the output cap)"),
      }),
      execute: async (args) => readRecord(bundle, args, capChars),
    }),
  } satisfies ToolSet;
}
