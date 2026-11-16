import { EmptyState } from "@/components/common/empty-state";
import { SectionCard } from "@/components/common/section-card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { fileDownloadHref } from "@/components/assets/format";
import type { AssetPageView } from "@/server/assets/asset-page";
import { formatBytes } from "@/server/assets/size-meter";

/** Files tab: path (download link), size, SHA-256 and whether git holds the content. */
export function FilesTab({ alias, view }: { alias: string; view: AssetPageView }) {
  const committed = view.detail.committed;
  const files = committed?.files ?? [];
  return (
    <SectionCard id="files" title="Files" aside={<span className="text-xs text-muted-foreground tabular-nums">{files.length}</span>}>
      {files.length === 0 ? (
        <EmptyState title={committed ? "No files" : "Not in the history yet"}>{committed ? "This version has no files." : "Files appear here after a sync saves this asset in the history."}</EmptyState>
      ) : (
        <Table className="text-[13px]">
          <caption className="sr-only">Files of {view.detail.displayName}</caption>
          <TableHeader>
            <TableRow className="hover:bg-transparent">
              <TableHead className="pl-4">Path</TableHead>
              <TableHead className="w-24 text-right">Size</TableHead>
              <TableHead className="w-36">SHA-256</TableHead>
              <TableHead className="w-28 pr-4">Committed</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {files.map((f) => (
              <TableRow key={f.path}>
                <TableCell className="max-w-0 py-2 pl-4">
                  {f.committed && committed ? (
                    <a className="block truncate rounded-sm font-mono text-xs leading-6 underline-offset-4 hover:underline" href={fileDownloadHref(alias, view.detail.asset.assetId, f.path, committed.commit)} title={`Download ${f.path}`}>
                      {f.path}
                    </a>
                  ) : (
                    <span className="block truncate font-mono text-xs" title={f.path}>
                      {f.path}
                    </span>
                  )}
                </TableCell>
                <TableCell className="py-2 text-right tabular-nums">{f.size === null ? "-" : formatBytes(f.size)}</TableCell>
                <TableCell className="py-2">
                  {f.sha256 ? (
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <button type="button" className="min-h-6 rounded-sm font-mono text-xs" aria-label={`SHA-256 ${f.sha256}`}>
                          {f.sha256.slice(0, 12)}
                        </button>
                      </TooltipTrigger>
                      <TooltipContent className="font-mono">{f.sha256}</TooltipContent>
                    </Tooltip>
                  ) : (
                    <span className="text-muted-foreground">-</span>
                  )}
                </TableCell>
                <TableCell className="py-2 pr-4">{f.committed ? "Yes" : "No, above the size threshold"}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
    </SectionCard>
  );
}
