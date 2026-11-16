/**
 * Delimited blocks for untrusted content in the reviewer's prompt and tool
 * results. Journal text, ground truth and analyzer output go inside a block
 * such as <condensed_trace> or <record n="12">. Any tag with one of these
 * names inside the content (opening or closing) has its "<" written as
 * "&lt;", so content cannot end its block early or open a block that looks
 * like the app's.
 */

export const BLOCK_TAGS = [
  "condensed_trace",
  "ground_truth",
  "ground_truth_fields",
  "analyzer",
  "record",
  "records",
  "search_results",
] as const;

export type BlockTag = (typeof BLOCK_TAGS)[number];

const TAG_RE = new RegExp(`<(\\s*/?\\s*)(${BLOCK_TAGS.join("|")})(?=[\\s/>]|$)`, "gi");

/** Content with every block tag of the reviewer's names neutralized. */
export function neutralizeTags(content: string): string {
  return content.replace(TAG_RE, "&lt;$1$2");
}

function attrValue(v: string | number): string {
  return String(v)
    .replace(/[\r\n\t]+/g, " ")
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

/** `<tag a="v">\ncontent\n</tag>` with the content and attribute values neutralized. */
export function block(tag: BlockTag, content: string, attrs: Record<string, string | number | null | undefined> = {}): string {
  const a = Object.entries(attrs)
    .filter(([, v]) => v !== null && v !== undefined && v !== "")
    .map(([k, v]) => ` ${k}="${attrValue(v as string | number)}"`)
    .join("");
  return `<${tag}${a}>\n${neutralizeTags(content)}\n</${tag}>`;
}
