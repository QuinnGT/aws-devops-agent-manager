import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { pythonSplitlines, pythonStrip, stripChars } from "./text";

/**
 * YAML frontmatter: a block between a leading "---" line and the next "---"
 * line, as SKILL.md files and memories use it.
 */

export interface Frontmatter {
  /** Parsed mapping, or null when there is no frontmatter block */
  data: Record<string, unknown> | null;
  /** YAML error when the block exists but is not a valid mapping */
  error?: string;
  /** Text after the block */
  body: string;
}

const BLOCK = /^---[ \t]*\r?\n(?:([\s\S]*?)\r?\n)?---[ \t]*(?:\r?\n|$)/;

export function hasFrontmatter(text: string): boolean {
  return BLOCK.test(text);
}

export function parseFrontmatter(text: string): Frontmatter {
  const m = BLOCK.exec(text);
  if (!m) return { data: null, body: text };
  const body = text.slice(m[0].length);
  try {
    const value: unknown = parseYaml(m[1] ?? "") ?? {};
    if (typeof value !== "object" || Array.isArray(value)) return { data: null, error: "frontmatter is not a mapping", body };
    return { data: value as Record<string, unknown>, body };
  } catch (e) {
    return { data: null, error: (e as Error).message.split("\n")[0], body };
  }
}

/** Frontmatter block plus body. Long strings stay on one line. */
export function renderFrontmatter(data: Record<string, unknown>, body: string): string {
  const yaml = stringifyYaml(data, { lineWidth: 0, minContentWidth: 0 });
  return `---\n${yaml}---\n${body}`;
}

/**
 * The simple frontmatter reader the package checks use (it mirrors a small
 * Python reader exactly): a "key: value" line outside indentation becomes
 * key -> value with whitespace and double quotes stripped. Takes text as
 * Python's read_text() returns it. Returns null when there is no frontmatter.
 */
export function pythonFrontmatter(text: string): Record<string, string> | null {
  if (!text.startsWith("---\n") || !text.slice(4).includes("\n---")) return null;
  const block = text.split("---")[1] ?? "";
  const out: Record<string, string> = {};
  for (const line of pythonSplitlines(block)) {
    if (!line.includes(":") || line.startsWith(" ")) continue;
    const i = line.indexOf(":");
    out[pythonStrip(line.slice(0, i))] = stripChars(pythonStrip(line.slice(i + 1)), '"');
  }
  return out;
}
