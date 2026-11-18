import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import type { QuickFix } from "@/server/validation/types";
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
  /** Where the error is, as a 1-based line and column of the whole file */
  errorAt?: { line: number; column: number };
  /** For the usual error, a value that holds ": " without quotes: the frontmatter with those values quoted */
  fix?: QuickFix;
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
    const block = (m[1] ?? "").split(/\r?\n/);
    const colon = unquotedColons(block);
    if (colon.length) {
      const first = colon[0]!;
      const fix = quotedFix(block, colon);
      return {
        data: null,
        error: `line ${first.colonLine + 2}, column ${first.colonColumn}: the ${first.key} value contains ": " without quotes, so YAML reads the rest of it as another key. Put the value in quotes`,
        errorAt: { line: first.colonLine + 2, column: first.colonColumn },
        ...(fix ? { fix } : {}),
        body,
      };
    }
    const at = (e as { linePos?: { line: number; col: number }[] }).linePos?.[0];
    return { data: null, error: yamlProblem((e as Error).message, at), ...(at ? { errorAt: { line: at.line + 1, column: at.col } } : {}), body };
  }
}

/** The parser's first line without its trailing colon and its own position (relative to the block), with the file's line instead. */
function yamlProblem(message: string, at: { line: number; col: number } | undefined): string {
  const first = (message.split("\n")[0] ?? "").replace(/:\s*$/, "").replace(/ at line \d+, column \d+$/, "");
  return at ? `line ${at.line + 1}, column ${at.col}: ${first}` : first;
}

/** "SKILL.md frontmatter isn't valid YAML at line 3, column 91: ...", for any check that reports a frontmatter error. */
export function yamlSentence(path: string, fm: Pick<Frontmatter, "error" | "errorAt">): string {
  return `${path} frontmatter isn't valid YAML${fm.errorAt ? " at " : ": "}${fm.error}.`;
}

/** The error's line, column and fix, for a ValidationResult. */
export function yamlAt(fm: Pick<Frontmatter, "errorAt" | "fix">): { line?: number; column?: number; fix?: QuickFix } {
  return { ...(fm.errorAt ? { line: fm.errorAt.line, column: fm.errorAt.column } : {}), ...(fm.fix ? { fix: fm.fix } : {}) };
}

/** A top-level `key: value` whose plain (unquoted) value, with its continuation lines, holds ": ". Lines are 0-based in the block. */
interface UnquotedColon {
  key: string;
  indent: string;
  start: number;
  count: number;
  value: string;
  colonLine: number;
  /** 1-based column of the ":" in that line */
  colonColumn: number;
}

const KEY_LINE = /^([ \t]*)([A-Za-z0-9_][A-Za-z0-9_.-]*):[ \t]+(\S.*)$/;

function unquotedColons(block: readonly string[]): UnquotedColon[] {
  const out: UnquotedColon[] = [];
  for (let i = 0; i < block.length; i++) {
    const m = KEY_LINE.exec(block[i]!);
    if (!m || m[1]) continue;
    const first = m[3]!;
    // Quoted, block, flow, alias, anchor and tag values aren't plain scalars.
    if (/^["'|>[{&*!%@`]/.test(first)) continue;
    let end = i + 1;
    while (end < block.length && /^[ \t]+\S/.test(block[end]!)) end++;
    const parts = [first, ...block.slice(i + 1, end).map((l) => l.trim())];
    if (!parts.some((p) => p.includes(": "))) continue;
    const hit = parts.findIndex((p) => p.includes(": "));
    const lineText = block[i + hit]!;
    const offset = hit === 0 ? m[0].length - first.length : lineText.length - lineText.trimStart().length;
    out.push({ key: m[2]!, indent: m[1]!, start: i, count: end - i, value: parts.join(" ").replace(/\s+#.*$/, ""), colonLine: i + hit, colonColumn: offset + parts[hit]!.indexOf(": ") + 1 });
    i = end - 1;
  }
  return out;
}

/** The block with each unquoted value in double quotes, as one fix of the whole block; null when that still doesn't parse. */
function quotedFix(block: readonly string[], colons: readonly UnquotedColon[]): QuickFix | null {
  const lines = [...block];
  for (const c of [...colons].reverse()) lines.splice(c.start, c.count, `${c.indent}${stringifyYaml({ [c.key]: c.value }, { lineWidth: 0, defaultStringType: "QUOTE_DOUBLE", defaultKeyType: "PLAIN" }).trimEnd()}`);
  try {
    const parsed: unknown = parseYaml(lines.join("\n"));
    if (!parsed || typeof parsed !== "object") return null;
  } catch {
    return null;
  }
  const keys = [...new Set(colons.map((c) => c.key))];
  return { label: `Put the ${keys.join(" and ")} ${keys.length === 1 ? "value" : "values"} in quotes`, edits: [{ kind: "replace-lines", line: 2, count: block.length, expect: block.join("\n"), text: lines.join("\n") }] };
}

/**
 * A fix that sets a frontmatter key to `value` (for a mirror mismatch), or
 * null when the file has no frontmatter block or the key isn't in it.
 */
export function frontmatterKeyFix(text: string, key: string, value: unknown, label: string): QuickFix | null {
  const m = BLOCK.exec(text);
  if (!m || m[1] === undefined) return null;
  const block = m[1].split(/\r?\n/);
  const i = block.findIndex((l) => new RegExp(`^${key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}:(\\s|$)`).test(l));
  if (i < 0) return null;
  let end = i + 1;
  while (end < block.length && /^[ \t]+\S/.test(block[end]!)) end++;
  const text2 = stringifyYaml({ [key]: value }, { lineWidth: 0 }).trimEnd();
  return { label, edits: [{ kind: "replace-lines", line: i + 2, count: end - i, expect: block.slice(i, end).join("\n"), text: text2 }] };
}

/** 1-based file line of a frontmatter key, or null. */
export function frontmatterKeyLine(text: string, key: string): number | null {
  const m = BLOCK.exec(text);
  if (!m || m[1] === undefined) return null;
  const i = m[1].split(/\r?\n/).findIndex((l) => l.startsWith(`${key}:`));
  return i < 0 ? null : i + 2;
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
