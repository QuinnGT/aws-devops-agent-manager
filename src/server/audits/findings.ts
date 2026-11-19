import type { Citation, ExtractFindings, FindingInput, FindingValues } from "./contract";
import type { AuditProfile } from "@/server/policy/sections/audits";

/**
 * Turns one review's output into findings. Pure.
 *
 * Each extractor in the profile gives one finding (`from: "$"`, the review
 * object itself) or one per element of a top-level array (`from: "fixes"`).
 * A finding's values are the extractor's `fields` only. Its citations are the
 * citation-check entries whose `field` path points into the finding:
 *   "$" extractor          the path's first key is one of the extractor's fields ("near_miss", "failure_modes[1]")
 *   array extractor "K"    the path is K[i] or K[i].<field> for element i ("fixes[0].evidence[1]")
 * A citation can belong to more than one extractor only if two extractors
 * name the same fields; each finding gets its own copy.
 *
 * The output is untrusted model text: nothing here evaluates it, and values
 * are copied as plain JSON.
 */

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => !!v && typeof v === "object" && !Array.isArray(v);

export const TITLE_MAX_CHARS = 300;

/** Path segments of a citation field: "fixes[0].evidence[1]" -> ["fixes", 0, "evidence", 1]. Also reads "fixes.0.fix" and a leading "$.". */
export function parseFieldPath(path: string): (string | number)[] {
  const out: (string | number)[] = [];
  const src = path.trim().replace(/^\$\.?/, "");
  const re = /([^.[\]]+)|\[(\d+)\]/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src))) {
    if (m[2] !== undefined) out.push(Number(m[2]));
    else if (/^\d+$/.test(m[1]!)) out.push(Number(m[1]));
    else out.push(m[1]!);
  }
  return out;
}

type Extractor = AuditProfile["findings"][number];

/** Whether a citation at `path` belongs to the finding of `extractor` at `ordinal`. `supports` (from a top-level `citations` entry) names the output key it backs. */
export function citationBelongs(extractor: Pick<Extractor, "from" | "fields">, ordinal: number, path: string, supports?: string): boolean {
  const seg = parseFieldPath(path);
  if (!seg.length) return false;
  if (extractor.from === "$") {
    if (typeof seg[0] === "string" && extractor.fields.includes(seg[0])) return true;
    // A "citations[i]" entry belongs where its `supports` key points ("near_miss", or "fixes[0]").
    if (!supports || seg[0] === supports) return false;
    const target = parseFieldPath(supports);
    return typeof target[0] === "string" && extractor.fields.includes(target[0]);
  }
  if (seg[0] !== extractor.from || seg[1] !== ordinal) {
    if (!supports || seg[0] === extractor.from) return false;
    const target = parseFieldPath(supports);
    return target[0] === extractor.from && target[1] === ordinal;
  }
  return seg.length === 2 || (typeof seg[2] === "string" && extractor.fields.includes(seg[2]));
}

function text(v: unknown): string {
  if (v === null || v === undefined) return "";
  if (typeof v === "string") return v;
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  if (Array.isArray(v)) return v.map(text).filter(Boolean).join(", ");
  return JSON.stringify(v);
}

/** Shorten to `max` characters at a word boundary when one is close, with "..." at the end. */
export function clipTitle(s: string, max = TITLE_MAX_CHARS): string {
  const one = s.replace(/\s+/g, " ").trim();
  if (one.length <= max) return one;
  const cut = one.slice(0, max - 3);
  const space = cut.lastIndexOf(" ");
  return `${(space > max * 0.6 ? cut.slice(0, space) : cut).trimEnd()}...`;
}

/** Fill a title template: {field} from the item, {incidentId} from the audit item. Unknown placeholders become empty. */
export function fillTitle(template: string, item: Obj, incidentId: string | null, max = TITLE_MAX_CHARS): string {
  return clipTitle(template.replace(/\{([A-Za-z0-9_]+)\}/g, (_m, key: string) => (key === "incidentId" ? (incidentId ?? "") : text(item[key]))), max);
}

function pick(item: Obj, fields: readonly string[]): FindingValues {
  const out: FindingValues = {};
  for (const f of fields) if (Object.hasOwn(item, f)) out[f] = structuredClone(item[f]);
  return out;
}

/** The title a finding shows: its template filled from the current values, or the extractor label and position when that is empty. */
export function findingTitle(extractor: Pick<Extractor, "title" | "label">, values: Obj, incidentId: string | null, ordinal: number, max = TITLE_MAX_CHARS): string {
  const t = fillTitle(extractor.title, values, incidentId, max).replace(/^[\s:()-]+$/, "");
  return t || `${extractor.label} ${ordinal + 1}`;
}

/**
 * The title with none of its text cut off. The stored title is cut at
 * TITLE_MAX_CHARS for the lists; a finding's own page shows this one.
 */
export function fullFindingTitle(extractor: Pick<Extractor, "title" | "label"> | undefined, stored: string, values: Obj, incidentId: string | null, ordinal: number): string {
  return extractor ? findingTitle(extractor, values, incidentId, ordinal, Number.POSITIVE_INFINITY) : stored;
}

export const extractFindings: ExtractFindings = (profile, output, ctx) => {
  if (!isObj(output)) return [];
  const citations: Citation[] = ctx.citationCheck?.citations ?? [];
  const out: FindingInput[] = [];
  for (const ex of profile.findings) {
    const items: [Obj, number][] =
      ex.from === "$"
        ? [[output, 0]]
        : Array.isArray(output[ex.from])
          ? (output[ex.from] as unknown[]).flatMap((el, i): [Obj, number][] => (isObj(el) ? [[el, i]] : []))
          : [];
    for (const [item, ordinal] of items) {
      out.push({
        kind: ex.kind,
        ordinal,
        // The title may use any field of the item, not only the stored ones.
        title: findingTitle(ex, item, ctx.incidentId, ordinal),
        values: pick(item, ex.fields),
        citations: citations.filter((c) => citationBelongs(ex, ordinal, c.field, c.supports)).map((c) => ({ ...c })),
      });
    }
  }
  return out;
};
