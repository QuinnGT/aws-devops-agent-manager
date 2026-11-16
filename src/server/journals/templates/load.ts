import type { RecordContent } from "@/lib/journal/types";
import { readPolicyFile, type LoadedPolicy, type Policy } from "@/server/policy";
import { compileTemplate, TemplateError, type CompiledTemplate } from "./engine";

/**
 * The markdown templates for one policy (app defaults overlaid with a
 * customer's history repository). Template files are read verbatim, except
 * that CRLF becomes LF and the file's final newline is not part of the
 * template: to end a template with a newline, end the file with a blank line.
 */

export interface TemplateSet {
  document: CompiledTemplate;
  record: CompiledTemplate;
  /** Body template for a record: `<type>.<kind>.md`, `<type>.md`, `_default.<kind>.md`, then the fallback */
  body(recordType: string, kind: RecordContent["kind"]): CompiledTemplate;
  /** Template for one message content part: `_part.<type>.md`, then the fallback */
  part(partType: string): CompiledTemplate;
  ui: { separator: string; nodes: Map<string, CompiledTemplate>; fallback: CompiledTemplate };
  markdown: Policy["journals"]["markdown"];
}

/**
 * Names that may become part of a template file name (record and part types
 * come from the API). A leading "_" is reserved for the app's own templates.
 */
const SAFE_NAME = /^[A-Za-z0-9][A-Za-z0-9_-]{0,99}$/;

export function normalizeTemplateSource(src: string): string {
  const lf = src.replace(/\r\n/g, "\n");
  return lf.endsWith("\n") ? lf.slice(0, -1) : lf;
}

export type TemplateReader = (relPath: string) => string | null;

export function policyTemplateReader(loaded: LoadedPolicy): TemplateReader {
  const dir = loaded.policy.journals.templatesDir;
  return (file) => readPolicyFile(loaded.dirs, `${dir}/${file}`);
}

export function loadTemplateSet(journals: Policy["journals"], read: TemplateReader): TemplateSet {
  const cache = new Map<string, CompiledTemplate | null>();
  const tryLoad = (file: string): CompiledTemplate | null => {
    if (cache.has(file)) return cache.get(file) ?? null;
    const src = read(file);
    const t = src === null ? null : compileTemplate(normalizeTemplateSource(src), file);
    cache.set(file, t);
    return t;
  };
  const required = (file: string): CompiledTemplate => {
    const t = tryLoad(file);
    if (!t) throw new TemplateError(`journal template ${journals.templatesDir}/${file} is missing`);
    return t;
  };

  const document = required(journals.documentTemplate);
  const record = required(journals.recordTemplate);
  const fallback = required(journals.fallbackTemplate);
  const fallbackPart = required(journals.fallbackPartTemplate);

  const ui = journals.uiTree;
  const nodes = new Map(Object.entries(ui.nodes).map(([type, src]) => [type, compileTemplate(src, `uiTree.nodes.${type}`)]));

  return {
    document,
    record,
    body(recordType, kind) {
      const candidates = SAFE_NAME.test(recordType) ? [`${recordType}.${kind}.md`, `${recordType}.md`] : [];
      candidates.push(`_default.${kind}.md`);
      for (const c of candidates) {
        const t = tryLoad(c);
        if (t) return t;
      }
      return fallback;
    },
    part(partType) {
      if (SAFE_NAME.test(partType)) {
        const t = tryLoad(`_part.${partType}.md`);
        if (t) return t;
      }
      return fallbackPart;
    },
    ui: { separator: ui.separator, nodes, fallback: compileTemplate(ui.default, "uiTree.default") },
    markdown: journals.markdown,
  };
}

/** Templates for a loaded policy, cached by policy digest. */
const setCache = new Map<string, TemplateSet>();

export function templateSetFor(loaded: LoadedPolicy): TemplateSet {
  const hit = setCache.get(loaded.digest);
  if (hit) return hit;
  const set = loadTemplateSet(loaded.policy.journals, policyTemplateReader(loaded));
  setCache.set(loaded.digest, set);
  return set;
}
