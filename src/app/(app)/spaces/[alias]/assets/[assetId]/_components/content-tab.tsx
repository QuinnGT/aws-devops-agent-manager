import { Download, File, GitCompare } from "lucide-react";
import Link from "next/link";
import type { ReactNode } from "react";
import { AssetTable, treeItems } from "@/components/assets/asset-table";
import { DeletedBadge } from "@/components/assets/badges";
import { RenderedMarkdown, SourceText, isMarkdownPath, unavailableReason } from "@/components/assets/file-content";
import { assetHref, assetTabHref, fileDownloadHref } from "@/components/assets/format";
import { PathTree } from "@/components/assets/path-tree";
import { SizeMeterView } from "@/components/assets/size-meter";
import { ContentViews } from "@/components/assets/view-toggle";
import { EmptyState } from "@/components/common/empty-state";
import { SectionCard } from "@/components/common/section-card";
import { SOURCE_STYLE, SourceBadge } from "@/components/common/source-badge";
import { displayPrincipal, shortSourceLabel } from "@/components/common/source-labels";
import { Time } from "@/components/common/time";
import { buttonVariants } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { cn } from "@/lib/utils";
import type { AssetPageView } from "@/server/assets/asset-page";
import type { AssetListRow } from "@/server/assets/browse";
import { formatBytes, countLines } from "@/server/assets/size-meter";
import { buildPathTree } from "@/server/assets/tree";
import { describeInterval, SUMMARY_VERSIONS, versionRef } from "@/server/assets/versions";

const outlineSm = buttonVariants({ variant: "outline", size: "sm" });
const ghostSm = buttonVariants({ variant: "ghost", size: "sm" });

type Files = NonNullable<AssetPageView["detail"]["committed"]>["files"];

function fileTitle(f: Files[number]): string {
  const parts = [f.path, f.size === null ? null : formatBytes(f.size), f.content !== null ? `${countLines(f.content)} ${countLines(f.content) === 1 ? "line" : "lines"}` : null];
  return parts.filter(Boolean).join(" · ");
}

/** The content card: header with the file and the Rendered or Source toggle, then the file. */
function FileCard({ alias, view, file, before, aside }: { alias: string; view: AssetPageView; file: Files[number]; before?: ReactNode; aside?: ReactNode }) {
  const { detail } = view;
  const title = <span className="font-mono text-xs break-all text-muted-foreground">{fileTitle(file)}</span>;
  const reason = unavailableReason(file);
  const commit = detail.committed?.commit;
  const body = (content: ReactNode) => (
    <div className={cn(aside && "grid md:grid-cols-[220px_minmax(0,1fr)]")}>
      {aside ? <nav aria-label="Files" className="border-b px-3 py-3 md:border-r md:border-b-0">{aside}</nav> : null}
      <div className="min-w-0">
        {before}
        {content}
      </div>
    </div>
  );
  if (reason || file.content === null) {
    return (
      <Card className="gap-0 overflow-hidden py-0" role="region" aria-label={`Content of ${file.path}`}>
        <div className="flex min-h-12 items-center border-b px-4 py-2">{title}</div>
        {body(
          <EmptyState title="Content not shown">
            {reason}{" "}
            {file.committed && commit ? (
              <a className="underline underline-offset-4" href={fileDownloadHref(alias, detail.asset.assetId, file.path, commit)}>
                Download {file.path}
              </a>
            ) : null}
          </EmptyState>,
        )}
      </Card>
    );
  }
  const source = <SourceText path={file.path} content={file.content} />;
  return (
    <Card className="gap-0 overflow-hidden py-0" role="region" aria-label={`Content of ${file.path}`}>
      {isMarkdownPath(file.path) ? (
        <ContentViews title={title} rendered={body(<div className="px-4 py-4">{<RenderedMarkdown content={file.content} />}</div>)} source={body(source)} />
      ) : (
        <>
          <div className="flex min-h-12 items-center border-b px-4 py-2">{title}</div>
          {body(source)}
        </>
      )}
    </Card>
  );
}

/** The four newest versions, the cadence line, and links to compare and to the Versions tab. */
function VersionsSummary({ alias, view }: { alias: string; view: AssetPageView }) {
  const { detail, points, cadence, entries } = view;
  const assetId = detail.asset.assetId;
  const policy = detail.policy;
  const newest = [...points].reverse().slice(0, SUMMARY_VERSIONS);
  const last = points.at(-1);
  const prev = points.at(-2);
  const byCommit = new Map(entries.map((e) => [e.commitHash, e]));
  const noun = policy.assetTypes.assetTypes[detail.asset.assetType]?.noun?.one ?? detail.typeLabel.toLowerCase();
  return (
    <SectionCard
      id="versions-summary"
      title="Versions"
      aside={
        last && prev ? (
          <Link className={outlineSm} href={assetTabHref(alias, assetId, "versions", { from: String(prev.version), to: String(last.version) })}>
            <GitCompare aria-hidden />
            Compare v{prev.version} and v{last.version}
          </Link>
        ) : undefined
      }
    >
      {cadence ? (
        <p className="border-b px-4 py-2.5 text-[13px] text-muted-foreground">
          {shortSourceLabel(cadence.source, policy.attribution)} updated this {noun} {cadence.count} times, about every {describeInterval(cadence.medianMs)}.
        </p>
      ) : null}
      {newest.length === 0 ? (
        <EmptyState title="No versions recorded yet">Versions appear here after a sync saves this asset in the history.</EmptyState>
      ) : (
        <ol>
          {newest.map((p, i) => {
            const e = byCommit.get(p.commit);
            const reason = e?.notes[0]?.reason ?? e?.pendingReasons[0]?.reason ?? null;
            const who = !reason && p.principal && (p.source === "console" || p.source === "cli") ? `By ${displayPrincipal(p.principal)}` : null;
            const note = reason ?? who;
            return (
              <li key={p.commit} className={cn("grid grid-cols-[12px_minmax(0,1fr)_auto] items-start gap-x-2.5 border-b px-4 py-2.5 text-[13px]", i === 0 && "bg-muted/50")}>
                <span className={cn("mt-2 size-2 rounded-full", SOURCE_STYLE[p.source].bar)} aria-hidden />
                <span className="flex flex-wrap items-center gap-2">
                  <Link className="inline-flex min-h-6 items-center rounded-sm font-semibold tabular-nums underline-offset-4 hover:underline" href={assetTabHref(alias, assetId, "content", { version: versionRef(entries, { version: p.version, commitHash: p.commit }) ?? String(p.version) })}>
                    v{p.version}
                  </Link>
                  <SourceBadge source={p.source} principal={p.principal} recordedLabel={p.sourceLabel} />
                </span>
                {p.at ? <Time value={p.at} format="date" className="pt-0.5 text-xs text-muted-foreground" /> : <span />}
                {note ? <p className="col-start-2 col-end-4 mt-1 text-xs break-words text-muted-foreground">{note}</p> : null}
              </li>
            );
          })}
        </ol>
      )}
      {points.length > newest.length ? (
        <div className="flex justify-center px-4 py-2">
          <Link className={ghostSm} href={assetTabHref(alias, assetId, "versions")}>
            Show all {points.length} {points.length === 1 ? "version" : "versions"}
          </Link>
        </div>
      ) : null}
    </SectionCard>
  );
}

function References({ alias, view }: { alias: string; view: AssetPageView }) {
  const refs = view.detail.references ?? [];
  const types = view.detail.policy.assetTypes.assetTypes;
  return (
    <SectionCard id="references" title="Uses">
      {refs.length === 0 ? (
        <EmptyState title="No skills or memory stores referenced">The metadata of this custom agent names no other assets.</EmptyState>
      ) : (
        <div className="space-y-3 px-4 py-3 text-[13px]">
          {refs.map((g) => (
            <div key={g.assetType ?? "unknown"}>
              <h3 className="mb-1 text-xs font-semibold text-muted-foreground">{g.assetType ? (types[g.assetType]?.noun?.other ?? types[g.assetType]?.label ?? g.assetType) : "Unknown asset IDs"}</h3>
              <ul className="space-y-1">
                {g.refs.map((r) => (
                  <li key={`${r.key}-${r.assetId}`} className="flex flex-wrap items-center gap-2">
                    {r.name ? (
                      <Link className="rounded-sm font-medium underline-offset-4 hover:underline" href={assetHref(alias, r.assetId)}>
                        {r.name}
                      </Link>
                    ) : (
                      <span className="font-mono text-xs">{r.assetId}</span>
                    )}
                    <DeletedBadge deleted={r.deleted} />
                    <span className="font-mono text-xs text-muted-foreground">{r.key}</span>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>
      )}
    </SectionCard>
  );
}

function FileLinks({ alias, view }: { alias: string; view: AssetPageView }) {
  const { detail } = view;
  const files = detail.committed?.files ?? [];
  const commit = detail.committed?.commit;
  return (
    <SectionCard id="artifact-files" title="Files">
      {files.length === 0 ? (
        <EmptyState title="No files">This version has no files.</EmptyState>
      ) : (
        <ul>
          {files.map((f) => (
            <li key={f.path} className="flex flex-wrap items-center justify-between gap-3 border-b px-4 py-2 text-[13px] last:border-b-0">
              <span className="inline-flex min-w-0 items-center gap-2">
                <File className="size-4 shrink-0 text-muted-foreground" aria-hidden />
                <span className="font-mono text-xs break-all">{f.path}</span>
                {f.size !== null ? <span className="text-xs text-muted-foreground tabular-nums">{formatBytes(f.size)}</span> : null}
              </span>
              {f.committed && commit ? (
                <a className={ghostSm} href={fileDownloadHref(alias, detail.asset.assetId, f.path, commit)}>
                  <Download aria-hidden />
                  Download<span className="sr-only"> {f.path}</span>
                </a>
              ) : (
                <span className="text-xs text-muted-foreground">Not in git (above the size threshold)</span>
              )}
            </li>
          ))}
        </ul>
      )}
    </SectionCard>
  );
}

export function ContentTab({
  alias,
  view,
  file,
  showVersions,
  statusCell,
}: {
  alias: string;
  view: AssetPageView;
  /** ?file= */
  file?: string;
  showVersions: boolean;
  statusCell: (row: AssetListRow) => ReactNode;
}) {
  const { detail } = view;
  const type = detail.asset.assetType;
  const files = detail.committed?.files ?? [];
  const entry = detail.policy.assetTypes.assetTypes[type];
  const noRenderedView = type === "artifact" || entry?.content === "binary";
  const selectedPath = file && files.some((f) => f.path === file) ? file : (detail.mainFile ?? files[0]?.path ?? null);
  const selected = files.find((f) => f.path === selectedPath) ?? null;
  const fileHref = (p: string) => assetTabHref(alias, detail.asset.assetId, "content", { ...(view.viewing?.commitHash ? { version: view.viewing.commitHash } : {}), file: p });

  let main: ReactNode;
  if (!detail.committed) {
    main = (
      <Card className="py-0">
        <EmptyState title="Not in the history yet">{detail.repo.ok ? "The content appears here after a sync saves this asset in the history." : "The history repository can't be read, so the content can't be shown."}</EmptyState>
      </Card>
    );
  } else if (noRenderedView) {
    main = <FileLinks alias={alias} view={view} />;
  } else if (!selected) {
    main = (
      <Card className="py-0">
        <EmptyState title="No files">This version has no files.</EmptyState>
      </Card>
    );
  } else {
    const tree =
      type === "skill" && files.length > 1 ? (
        <PathTree
          nodes={buildPathTree(files, (f) => f.path)}
          renderItem={(f, node) => (
            <Link
              className={cn("block truncate rounded-sm px-1 py-0.5 font-mono text-xs leading-5 underline-offset-4 hover:underline", f.path === selected.path && "bg-muted font-semibold")}
              aria-current={f.path === selected.path ? "true" : undefined}
              href={fileHref(f.path)}
              title={f.path}
            >
              {node.name}
            </Link>
          )}
        />
      ) : undefined;
    const meter = type === "agents_md" && detail.meter && selected.path === detail.mainFile ? <div className="border-b px-4 py-3">{<SizeMeterView meter={detail.meter} />}</div> : undefined;
    main = <FileCard alias={alias} view={view} file={selected} before={meter} aside={tree} />;
  }

  const memories = view.memories ? (
    <SectionCard id="store-memories" title={`Memories in ${detail.asset.name}`} aside={<span className="text-xs text-muted-foreground tabular-nums">{view.memories.length}</span>}>
      {view.memories.length === 0 ? (
        <EmptyState title="No memories in this store">DevOps Agent or a plan adds memories here.</EmptyState>
      ) : (
        <AssetTable alias={alias} caption={`Memories in ${detail.asset.name}`} items={treeItems(buildPathTree(view.memories, (m) => m.name))} status={statusCell} />
      )}
    </SectionCard>
  ) : null;

  return (
    <div className="grid items-start gap-4 xl:grid-cols-[minmax(0,1fr)_360px]">
      <div className="min-w-0 space-y-4">
        {main}
        {memories}
        {type === "custom_agent" ? <References alias={alias} view={view} /> : null}
      </div>
      {showVersions ? <VersionsSummary alias={alias} view={view} /> : null}
    </div>
  );
}
