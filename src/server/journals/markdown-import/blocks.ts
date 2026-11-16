import type { JournalImportFormat } from "@/server/policy/sections/journal-import";

/**
 * Recovers message structure (thinking, tool calls, tool results, text) from
 * a rendered message, using the format's patterns. The result uses the same
 * block shapes as API message content, so analyzers can read both the same way:
 *   { type: "text", text }
 *   { type: "thinking", thinking }
 *   { type: "tool_use", tool_name, input, input_complete }
 *   { type: "tool_result", status, content: [{ text }] }
 */

export type RecoveredBlock =
  | { type: "text"; text: string }
  | { type: "thinking"; thinking: string }
  | { type: "tool_use"; tool_name: string; input: unknown; input_complete: boolean }
  | { type: "tool_result"; status: string | null; content: { text: string }[] };

interface Hit {
  start: number;
  end: number;
  block: RecoveredBlock;
}

export interface CompiledBlockPatterns {
  thinking?: RegExp;
  toolCall?: RegExp;
  toolResult?: RegExp;
  partialInputKeys: string[];
}

export function compileBlockPatterns(f: JournalImportFormat): CompiledBlockPatterns | null {
  if (!f.thinking && !f.toolCall && !f.toolResult) return null;
  return {
    thinking: f.thinking ? new RegExp(f.thinking, "gm") : undefined,
    toolCall: f.toolCall ? new RegExp(f.toolCall, "gm") : undefined,
    toolResult: f.toolResult ? new RegExp(f.toolResult, "gm") : undefined,
    partialInputKeys: f.partialInputKeys,
  };
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function parseToolInput(source: string, partialKeys: string[]): { input: unknown; complete: boolean } {
  try {
    return { input: JSON.parse(source), complete: true };
  } catch {
    const input: Record<string, string> = {};
    for (const key of partialKeys) {
      const m = new RegExp(`"${escapeRegExp(key)}"\\s*:\\s*"([^"]+)"`).exec(source);
      if (m?.[1] !== undefined) input[key] = m[1];
    }
    return { input, complete: false };
  }
}

function collect(re: RegExp | undefined, text: string, make: (g: Record<string, string | undefined>) => RecoveredBlock, out: Hit[]) {
  if (!re) return;
  re.lastIndex = 0;
  for (const m of text.matchAll(re)) {
    if (m[0].length === 0) continue;
    out.push({ start: m.index, end: m.index + m[0].length, block: make(m.groups ?? {}) });
  }
}

/** Returns null when the text has no markup this format knows (plain text message). */
export function recoverBlocks(text: string, p: CompiledBlockPatterns): RecoveredBlock[] | null {
  const hits: Hit[] = [];
  collect(p.thinking, text, (g) => ({ type: "thinking", thinking: (g.thinking ?? "").trim() }), hits);
  collect(
    p.toolCall,
    text,
    (g) => {
      const { input, complete } = parseToolInput(g.input ?? "", p.partialInputKeys);
      return { type: "tool_use", tool_name: (g.name ?? "").trim(), input, input_complete: complete };
    },
    hits,
  );
  collect(
    p.toolResult,
    text,
    (g) => ({ type: "tool_result", status: g.status?.trim() || null, content: [{ text: g.text ?? "" }] }),
    hits,
  );
  if (!hits.length) return null;

  // Earliest first; on the same start, the longer match wins. Overlaps are dropped.
  hits.sort((a, b) => a.start - b.start || b.end - a.end);
  const blocks: RecoveredBlock[] = [];
  let pos = 0;
  const pushText = (s: string) => {
    const t = s.trim();
    if (t) blocks.push({ type: "text", text: t });
  };
  for (const h of hits) {
    if (h.start < pos) continue;
    pushText(text.slice(pos, h.start));
    blocks.push(h.block);
    pos = h.end;
  }
  pushText(text.slice(pos));
  return blocks;
}
