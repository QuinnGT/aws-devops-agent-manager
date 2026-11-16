import type { ComponentProps } from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import rehypeSanitize from "rehype-sanitize";
import remarkGfm from "remark-gfm";

type HeadingTag = "h1" | "h2" | "h3" | "h4" | "h5" | "h6";
const HEADINGS: readonly HeadingTag[] = ["h1", "h2", "h3", "h4", "h5", "h6"];

/** Components that render each heading `offset` levels lower (h1 becomes h3 for offset 2), capped at h6. */
function shiftedHeadings(offset: number): Components {
  const out: Components = {};
  HEADINGS.forEach((tag, i) => {
    const Tag = HEADINGS[Math.min(5, i + offset)]!;
    out[tag] = function Heading({ node: _node, ...props }: ComponentProps<HeadingTag> & { node?: unknown }) {
      return <Tag {...props} />;
    };
  });
  return out;
}

/**
 * Renders untrusted markdown (journal content, asset content, model output).
 * Raw HTML is never rendered (no rehype-raw) and the output is sanitized.
 * Always use this component for content that came from an Agent Space or a model.
 *
 * `headingOffset` renders headings that many levels lower, so content inside
 * a card doesn't add a second h1 to the page (one h1 per page).
 */
export function SafeMarkdown({ children, className, headingOffset = 0 }: { children: string; className?: string; headingOffset?: number }) {
  return (
    <div className={className ?? "prose prose-sm max-w-none dark:prose-invert"}>
      <ReactMarkdown remarkPlugins={[remarkGfm]} rehypePlugins={[rehypeSanitize]} skipHtml components={headingOffset > 0 ? shiftedHeadings(headingOffset) : undefined}>
        {children}
      </ReactMarkdown>
    </div>
  );
}
