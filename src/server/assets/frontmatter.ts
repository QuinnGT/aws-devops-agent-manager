import { parse } from "yaml";

/**
 * YAML frontmatter at the top of SKILL.md and memory files. Pure.
 * The yaml package's default schema has no executable tags.
 */

export interface Frontmatter {
  /** Parsed mapping, or null when there is none or it is not a mapping */
  data: Record<string, unknown> | null;
  /** The YAML text between the fences, or null when there is no frontmatter */
  raw: string | null;
  /** The content after the closing fence (the whole text when there is no frontmatter) */
  body: string;
  /** Parse error, if the frontmatter is not valid YAML */
  error: string | null;
}

const FENCE = /^---[ \t]*\r?$/;
const CLOSE = /^(---|\.\.\.)[ \t]*\r?$/;

export function splitFrontmatter(text: string): Frontmatter {
  const src = text.startsWith("\uFEFF") ? text.slice(1) : text;
  const lines = src.split("\n");
  if (!FENCE.test(lines[0] ?? "")) return { data: null, raw: null, body: text, error: null };
  const end = lines.findIndex((l, i) => i > 0 && CLOSE.test(l));
  if (end < 0) return { data: null, raw: null, body: text, error: null };
  const raw = lines
    .slice(1, end)
    .map((l) => l.replace(/\r$/, ""))
    .join("\n");
  const body = lines.slice(end + 1).join("\n");
  try {
    const parsed: unknown = raw.trim() === "" ? {} : parse(raw, { maxAliasCount: 100 });
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return { data: parsed as Record<string, unknown>, raw, body, error: null };
    }
    return { data: null, raw, body, error: "Frontmatter is not a key-value mapping" };
  } catch (err) {
    return { data: null, raw, body, error: err instanceof Error ? err.message.split("\n")[0]! : String(err) };
  }
}

/** Values for display: a list stays a list, a scalar becomes one entry, nested values become JSON. */
export function displayValues(v: unknown): string[] {
  if (v === undefined || v === null || v === "") return [];
  if (Array.isArray(v)) return v.flatMap((x) => displayValues(x));
  if (typeof v === "string") return [v];
  if (typeof v === "number" || typeof v === "boolean") return [String(v)];
  return [JSON.stringify(v)];
}
