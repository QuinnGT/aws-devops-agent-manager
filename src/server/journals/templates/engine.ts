/**
 * Logic-less placeholder templates for journal markdown.
 *
 * Syntax: `{{path}}` or `{{path|filter|filter:arg}}`. A path is a dotted
 * lookup into the render context (`content.title`, `part.input`). There are no
 * conditionals, loops, partials or expressions, and nothing is evaluated: a
 * placeholder can only read own properties of plain data and pass them through
 * the fixed filters below. Unknown filters fail when the template is compiled.
 *
 * Values: strings as they are, numbers and booleans with String(), null and
 * missing values as "", dates as ISO 8601, objects and arrays as JSON (2-space indent).
 *
 * Filters:
 *   json             JSON with 2-space indent
 *   json-ascii       the same, with non-ASCII escaped as \uXXXX (Python json.dumps(indent=2))
 *   length           length in characters (code points), or array length
 *   python-datetime  "2026-10-12 18:36:05.759000+00:00" (Python str(datetime) in UTC)
 *   iso              ISO 8601
 *   hashes           a number n as n "#" characters (1 to 6)
 *   join-text        an array of { text } parts joined into one string
 *   truncate:N       the first N characters, followed by the policy's truncation notice
 *   ui-tree          a ui_investigation_summary node tree as markdown blocks (policy uiTree)
 */

export class TemplateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TemplateError";
  }
}

const FILTERS = ["json", "json-ascii", "length", "python-datetime", "iso", "hashes", "join-text", "truncate", "ui-tree"] as const;
type FilterName = (typeof FILTERS)[number];

interface FilterCall {
  name: FilterName;
  arg?: number;
}

type Segment = { kind: "text"; text: string } | { kind: "expr"; path: string[]; filters: FilterCall[] };

export interface CompiledTemplate {
  name: string;
  segments: Segment[];
}

export interface RenderHelpers {
  /** Appended by `truncate`; `{{total}}` is replaced by the full length */
  truncationNotice?: string;
  /** Renders a ui node tree (the `ui-tree` filter) */
  uiTree?: (node: unknown) => string;
}

const PLACEHOLDER = /\{\{([^{}]*)\}\}/g;
const PATH = /^[A-Za-z_][A-Za-z0-9_-]*(?:\.[A-Za-z0-9_-]+)*$/;
const FORBIDDEN_KEYS = new Set(["__proto__", "prototype", "constructor"]);

export function compileTemplate(source: string, name: string): CompiledTemplate {
  const segments: Segment[] = [];
  let last = 0;
  for (const m of source.matchAll(PLACEHOLDER)) {
    const start = m.index ?? 0;
    if (start > last) segments.push({ kind: "text", text: source.slice(last, start) });
    segments.push(parseExpr((m[1] ?? "").trim(), name));
    last = start + m[0].length;
  }
  if (last < source.length) segments.push({ kind: "text", text: source.slice(last) });
  return { name, segments };
}

function parseExpr(expr: string, name: string): Segment {
  const [pathPart, ...filterParts] = expr.split("|").map((s) => s.trim());
  if (!pathPart || !PATH.test(pathPart)) throw new TemplateError(`${name}: invalid placeholder {{${expr}}}`);
  const path = pathPart.split(".");
  if (path.some((k) => FORBIDDEN_KEYS.has(k))) throw new TemplateError(`${name}: placeholder {{${expr}}} uses a reserved key`);
  const filters = filterParts.map((f): FilterCall => {
    const [fname, arg] = f.split(":").map((s) => s.trim());
    if (!fname || !(FILTERS as readonly string[]).includes(fname)) throw new TemplateError(`${name}: unknown filter "${fname}" in {{${expr}}}`);
    if (fname === "truncate") {
      const n = Number(arg);
      if (!Number.isInteger(n) || n < 1) throw new TemplateError(`${name}: truncate needs a positive whole number, as in truncate:2000`);
      return { name: fname, arg: n };
    }
    if (arg !== undefined) throw new TemplateError(`${name}: filter "${fname}" takes no argument`);
    return { name: fname as FilterName };
  });
  return { kind: "expr", path, filters };
}

/** Own-property lookup only: templates can never reach prototypes or functions. */
export function lookup(ctx: unknown, path: readonly string[]): unknown {
  let v: unknown = ctx;
  for (const key of path) {
    if (v === null || typeof v !== "object" || FORBIDDEN_KEYS.has(key)) return undefined;
    if (!Object.prototype.hasOwnProperty.call(v, key)) return undefined;
    v = (v as Record<string, unknown>)[key];
    if (typeof v === "function") return undefined;
  }
  return v;
}

export function renderTemplate(t: CompiledTemplate, ctx: Record<string, unknown>, helpers: RenderHelpers = {}): string {
  let out = "";
  for (const s of t.segments) {
    if (s.kind === "text") {
      out += s.text;
      continue;
    }
    let v = lookup(ctx, s.path);
    for (const f of s.filters) v = applyFilter(f, v, helpers);
    out += toText(v);
  }
  return out;
}

/** Render a one-off template string (used for small policy strings such as file names). */
export function renderString(source: string, ctx: Record<string, unknown>, helpers: RenderHelpers = {}, name = "inline"): string {
  return renderTemplate(compileTemplate(source, name), ctx, helpers);
}

export function toText(v: unknown): string {
  if (v === null || v === undefined) return "";
  if (typeof v === "string") return v;
  if (typeof v === "number" || typeof v === "boolean" || typeof v === "bigint") return String(v);
  if (v instanceof Date) return Number.isNaN(v.getTime()) ? "" : v.toISOString();
  return jsonPretty(v);
}

function applyFilter(f: FilterCall, v: unknown, helpers: RenderHelpers): unknown {
  switch (f.name) {
    case "json":
      return jsonPretty(v);
    case "json-ascii":
      return pythonJsonDumps(v);
    case "length":
      if (Array.isArray(v)) return v.length;
      return codePointLength(toText(v));
    case "python-datetime": {
      const d = asDate(v);
      return d ? pythonDatetime(d) : toText(v);
    }
    case "iso": {
      const d = asDate(v);
      return d ? d.toISOString() : toText(v);
    }
    case "hashes": {
      const n = Math.min(6, Math.max(1, Math.trunc(Number(v)) || 1));
      return "#".repeat(n);
    }
    case "join-text":
      return joinText(v);
    case "truncate":
      return truncate(toText(v), f.arg ?? 0, helpers.truncationNotice ?? "");
    case "ui-tree":
      return helpers.uiTree ? helpers.uiTree(v) : "";
  }
}

function jsonPretty(v: unknown): string {
  return JSON.stringify(v === undefined ? null : v, null, 2) ?? "null";
}

/**
 * Python's json.dumps(v, indent=2) with the default ensure_ascii=True: the
 * same layout as JSON.stringify(v, null, 2), with every character outside
 * printable ASCII written as a lowercase \uXXXX escape (surrogate pairs as two escapes).
 */
export function pythonJsonDumps(v: unknown): string {
  return jsonPretty(v).replace(/[\u007f-\uffff]/g, (c) => "\\u" + c.charCodeAt(0).toString(16).padStart(4, "0"));
}

function codePointLength(s: string): number {
  let n = 0;
  for (const _ of s) n++;
  return n;
}

function truncate(s: string, max: number, notice: string): string {
  const cps = Array.from(s);
  if (cps.length <= max) return s;
  return cps.slice(0, max).join("") + notice.replaceAll("{{total}}", String(cps.length));
}

function joinText(v: unknown): string {
  if (typeof v === "string") return v;
  if (!Array.isArray(v)) return "";
  return v
    .map((p) => {
      if (typeof p === "string") return p;
      const t = lookup(p, ["text"]);
      return typeof t === "string" ? t : "";
    })
    .join("");
}

function asDate(v: unknown): Date | null {
  if (v instanceof Date) return Number.isNaN(v.getTime()) ? null : v;
  if (typeof v === "string" || typeof v === "number") {
    const d = new Date(v);
    return Number.isNaN(d.getTime()) ? null : d;
  }
  return null;
}

/** Python str(datetime) for an aware UTC datetime: microseconds are omitted when zero. */
export function pythonDatetime(d: Date): string {
  const p = (n: number, w = 2) => String(n).padStart(w, "0");
  const base = `${p(d.getUTCFullYear(), 4)}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())}`;
  const ms = d.getUTCMilliseconds();
  return `${base}${ms ? `.${p(ms, 3)}000` : ""}+00:00`;
}
