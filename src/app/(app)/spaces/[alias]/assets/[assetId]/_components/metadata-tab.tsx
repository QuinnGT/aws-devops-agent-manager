import { ValueChanges } from "@/components/assets/diff-view";
import { EmptyState } from "@/components/common/empty-state";
import { SectionCard } from "@/components/common/section-card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import type { AssetPageView } from "@/server/assets/asset-page";
import { showValue } from "@/server/assets/diff";

/** Metadata tab: the current metadata as keys and values, then what changed in the newest version. */
export function MetadataTab({ view }: { view: AssetPageView }) {
  const metadata = view.detail.metadata;
  const keys = Object.keys(metadata).sort();
  const latest = view.latestChange;
  const version = view.latest?.version ?? null;
  return (
    <div className="space-y-4">
      <SectionCard id="metadata" title="Metadata" aside={<span className="text-xs text-muted-foreground tabular-nums">{keys.length} keys</span>}>
        {keys.length === 0 ? (
          <EmptyState title="No metadata">This asset has no metadata keys.</EmptyState>
        ) : (
          <Table className="text-[13px]">
            <caption className="sr-only">Current metadata</caption>
            <TableHeader>
              <TableRow className="hover:bg-transparent">
                <TableHead className="w-56 pl-4">Key</TableHead>
                <TableHead className="pr-4">Value</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {keys.map((k) => {
                const v = metadata[k];
                return (
                  <TableRow key={k} className="align-top">
                    <TableCell className="py-2 pl-4 font-mono text-xs">{k}</TableCell>
                    <TableCell className="max-w-0 py-2 pr-4">
                      {typeof v === "string" ? (
                        <span className="block max-w-[72ch] break-words whitespace-pre-wrap">{v}</span>
                      ) : (
                        <pre className="font-mono text-xs break-words whitespace-pre-wrap">{showValue(v)}</pre>
                      )}
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        )}
      </SectionCard>
      <SectionCard id="metadata-changed" title={version !== null ? `Changed in v${version}` : "Changed in the newest version"}>
        {latest ? (
          <ValueChanges changes={latest.diff.metadata} empty={`The metadata didn't change in v${latest.version ?? version}.`} />
        ) : (
          <EmptyState title="Nothing to compare">{version !== null ? `v${version} is the first recorded version of this asset.` : "No versions are recorded in the history yet."}</EmptyState>
        )}
      </SectionCard>
    </div>
  );
}
