import { stringify } from "yaml";
import { SafeMarkdown } from "@/components/safe-markdown";
import { splitFrontmatter } from "@/server/assets/frontmatter";
import { formatBytes } from "@/server/assets/size-meter";

/**
 * One asset file, Rendered or Source (pages/asset-detail.md, "Content card").
 * Asset content is untrusted: markdown goes through SafeMarkdown, everything
 * else is plain text in <pre>. Server components.
 */

export function isMarkdownPath(path: string): boolean {
  return /\.(md|markdown)$/i.test(path);
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

function scalarText(v: unknown): string | null {
  if (v === null || v === undefined) return "";
  if (typeof v === "string") return v;
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  return null;
}

/** Nested values as YAML text, the way the file writes them. */
function NestedValue({ value }: { value: unknown }) {
  const s = scalarText(value);
  if (s !== null) return <span className="break-words whitespace-pre-wrap">{s}</span>;
  return <pre className="font-mono text-xs break-words whitespace-pre-wrap">{stringify(value, { lineWidth: 0 }).trimEnd()}</pre>;
}

/** A list of objects (memory `claim` entries) as a table whose columns are the object keys. */
function ObjectTable({ name, rows }: { name: string; rows: Record<string, unknown>[] }) {
  const keys = [...new Set(rows.flatMap((r) => Object.keys(r)))];
  return (
    <div className="overflow-x-auto rounded-md border">
      <table className="w-full text-[13px]">
        <caption className="sr-only">{name}</caption>
        <thead>
          <tr className="border-b bg-muted text-left text-xs text-muted-foreground">
            {keys.map((k) => (
              <th key={k} scope="col" className="px-3 py-1.5 font-medium whitespace-nowrap">
                {k}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={i} className="border-b align-top last:border-b-0">
              {keys.map((k) => (
                <td key={k} className="max-w-[60ch] min-w-24 px-3 py-2">
                  <NestedValue value={r[k]} />
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** YAML frontmatter as a definition list; lists of objects become small tables. */
export function FrontmatterList({ data }: { data: Record<string, unknown> }) {
  const entries = Object.entries(data);
  if (entries.length === 0) return null;
  return (
    <dl className="grid grid-cols-[minmax(6rem,max-content)_minmax(0,1fr)] gap-x-4 gap-y-2 text-[13px]">
      {entries.map(([k, v]) => {
        const objects = Array.isArray(v) && v.length > 0 && v.every(isPlainObject);
        if (objects) {
          return (
            <div key={k} className="col-span-2 space-y-1.5">
              <dt className="font-mono text-xs text-muted-foreground">
                {k} <span className="tabular-nums">({v.length})</span>
              </dt>
              <dd>
                <ObjectTable name={k} rows={v as Record<string, unknown>[]} />
              </dd>
            </div>
          );
        }
        const list = Array.isArray(v) && v.every((x) => scalarText(x) !== null);
        return (
          <div key={k} className="contents">
            <dt className="pt-px font-mono text-xs text-muted-foreground">{k}</dt>
            <dd className="max-w-[72ch] min-w-0">
              {list ? (
                <span className="flex flex-wrap gap-1">
                  {(v as unknown[]).map((x, i) => (
                    <span key={i} className="rounded-md bg-muted px-1.5 font-mono text-xs leading-5">
                      {scalarText(x)}
                    </span>
                  ))}
                </span>
              ) : (
                <NestedValue value={v} />
              )}
            </dd>
          </div>
        );
      })}
    </dl>
  );
}

/** The Rendered view of a markdown file: frontmatter, then the body through SafeMarkdown. */
export function RenderedMarkdown({ content }: { content: string }) {
  const fm = splitFrontmatter(content);
  return (
    <div className="space-y-4">
      {fm.data ? <FrontmatterList data={fm.data} /> : null}
      {fm.error ? <p className="text-xs text-warning-fg">The frontmatter is not valid YAML ({fm.error}), so it is shown as text below.</p> : null}
      {fm.error && fm.raw !== null ? <pre className="overflow-x-auto rounded-md border bg-muted p-3 font-mono text-xs">{fm.raw}</pre> : null}
      <SafeMarkdown className="prose prose-sm max-w-[72ch] dark:prose-invert prose-headings:font-semibold prose-code:before:content-none prose-code:after:content-none" headingOffset={2}>
        {fm.body}
      </SafeMarkdown>
    </div>
  );
}

/** The raw file in a monospace block that scrolls sideways. JSON is pretty-printed. */
export function SourceText({ path, content }: { path: string; content: string }) {
  let text = content;
  if (/\.json$/i.test(path)) {
    try {
      text = JSON.stringify(JSON.parse(content), null, 2);
    } catch {
      text = content;
    }
  }
  return <pre className="max-h-[48rem] overflow-auto px-4 py-3 font-mono text-xs leading-5 whitespace-pre">{text}</pre>;
}

/** Why a file can't be shown inline, or null when its content is available. */
export function unavailableReason(file: { content: string | null; size: number | null; committed: boolean }): string | null {
  if (!file.committed) return `Not committed to git: above the size threshold (${file.size === null ? "unknown size" : formatBytes(file.size)}). Git keeps its hash in asset.json.`;
  if (file.content === null) return `Too large to show here${file.size === null ? "" : ` (${formatBytes(file.size)})`}. Download the file instead.`;
  if (file.content.includes("\u0000")) return "Binary file, not shown.";
  return null;
}
