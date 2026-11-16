import rehypeSanitize from "rehype-sanitize";
import remarkGfm from "remark-gfm";
import remarkParse from "remark-parse";
import remarkRehype from "remark-rehype";
import { unified } from "unified";

/**
 * Untrusted markdown (narrative text from a model or a person) to an HTML
 * string for the self-contained export. Same pipeline as
 * src/components/safe-markdown.tsx (remark-gfm, raw HTML dropped,
 * rehype-sanitize with its default schema), without React: react-dom/server
 * is not allowed in the server component graph that a Route Handler is part of.
 *
 * On top of the sanitizer, the serializer below writes only an allowlist of
 * tags and attributes, so the file stays free of scripts and of anything the
 * browser would fetch or navigate to: links become their text, images their
 * alt text.
 */

interface HNode {
  type: string;
  tagName?: string;
  properties?: Record<string, unknown>;
  children?: HNode[];
  value?: string;
}

const processor = unified().use(remarkParse).use(remarkGfm).use(remarkRehype).use(rehypeSanitize).freeze();

export function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

const KEEP = new Set([
  "p",
  "br",
  "hr",
  "strong",
  "em",
  "del",
  "s",
  "code",
  "pre",
  "blockquote",
  "ul",
  "ol",
  "li",
  "table",
  "thead",
  "tbody",
  "tr",
  "th",
  "td",
  "sup",
  "sub",
  "kbd",
  "dl",
  "dt",
  "dd",
]);
const VOID = new Set(["br", "hr"]);
const HEADING = /^h([1-6])$/;
const ALIGN = new Set(["left", "center", "right"]);

function attrs(tag: string, p: Record<string, unknown>): string {
  if (tag === "ol" && typeof p.start === "number" && Number.isInteger(p.start) && p.start > 0 && p.start !== 1) return ` start="${p.start}"`;
  if ((tag === "td" || tag === "th") && typeof p.align === "string" && ALIGN.has(p.align)) return ` style="text-align:${p.align}"`;
  return "";
}

function serialize(node: HNode, headingOffset: number): string {
  switch (node.type) {
    case "root":
      return (node.children ?? []).map((c) => serialize(c, headingOffset)).join("");
    case "text":
      return escapeHtml(node.value ?? "");
    case "element": {
      const tag = node.tagName ?? "";
      const inner = () => (node.children ?? []).map((c) => serialize(c, headingOffset)).join("");
      if (tag === "img") return typeof node.properties?.alt === "string" ? escapeHtml(node.properties.alt) : "";
      if (tag === "input") return node.properties?.type === "checkbox" ? (node.properties.checked ? "[x]" : "[ ]") : "";
      const h = HEADING.exec(tag);
      if (h) {
        const level = Math.min(6, Number(h[1]) + headingOffset);
        return `<h${level}>${inner()}</h${level}>`;
      }
      if (!KEEP.has(tag)) return inner();
      if (VOID.has(tag)) return `<${tag}>`;
      return `<${tag}${attrs(tag, node.properties ?? {})}>${inner()}</${tag}>`;
    }
    default:
      // comments, doctypes and raw nodes are never written
      return "";
  }
}

/** Render untrusted markdown as sanitized HTML. `headingOffset` moves headings down (h1 becomes h3 for 2), capped at h6. */
export function markdownToSafeHtml(markdown: string, opts: { headingOffset?: number } = {}): string {
  const tree = processor.runSync(processor.parse(markdown)) as unknown as HNode;
  return serialize(tree, Math.max(0, opts.headingOffset ?? 0));
}
