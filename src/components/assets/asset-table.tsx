import { Database, Folder } from "lucide-react";
import Link from "next/link";
import type { ReactNode } from "react";
import { SourceBadge } from "@/components/common/source-badge";
import { Time } from "@/components/common/time";
import { VersionBadge } from "@/components/common/version-badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import type { AssetListRow } from "@/server/assets/browse";
import type { MemoryGroup } from "@/server/assets/sections";
import type { TreeNode } from "@/server/assets/tree";
import { DeletedBadge, ManagedBadge } from "./badges";
import { assetHref } from "./format";

/**
 * Assets of one type (design-system MASTER "Page index"): name,
 * status, VersionBadge and the last change as SourceBadge plus Time. Memories
 * keep their folder names as indented group rows (the PathTree layout).
 */

export type AssetTableItem = { kind: "asset"; row: AssetListRow; depth: number; label: string } | { kind: "group"; key: string; depth: number; label: ReactNode };

/** Rows for a folder tree: a folder row, then its items one level in. Pure. */
export function treeItems(nodes: readonly TreeNode<AssetListRow>[], depth = 0): AssetTableItem[] {
  return nodes.flatMap((n): AssetTableItem[] => {
    const own = n.items.map((row): AssetTableItem => ({ kind: "asset", row, depth, label: n.name }));
    if (n.children.length === 0) return own;
    const head: AssetTableItem[] = own.length
      ? own
      : [
          {
            kind: "group",
            key: `f:${n.path}`,
            depth,
            label: (
              <span className="inline-flex items-center gap-1.5 text-muted-foreground">
                <Folder className="size-4" aria-hidden />
                {n.name}/
              </span>
            ),
          },
        ];
    return [...head, ...treeItems(n.children, depth + 1)];
  });
}

/** Memories under a store row each, then their folders. */
export function memoryItems(alias: string, groups: readonly MemoryGroup[]): AssetTableItem[] {
  return groups.flatMap((g): AssetTableItem[] => [
    {
      kind: "group",
      key: `s:${g.storeId ?? "none"}`,
      depth: 0,
      label: (
        <span className="inline-flex items-center gap-1.5 font-semibold">
          <Database className="size-4 text-muted-foreground" aria-hidden />
          {g.store ? (
            <Link className="inline-flex min-h-6 items-center rounded-sm underline-offset-4 hover:underline" href={assetHref(alias, g.store.assetId)}>
              {g.store.name}
            </Link>
          ) : (
            <span>{g.storeId ? `Unknown store ${g.storeId}` : "No store"}</span>
          )}
          {g.store ? <ManagedBadge managed={g.store.managed} compact /> : null}
          <span className="text-xs font-normal text-muted-foreground tabular-nums">
            {g.count} {g.count === 1 ? "memory" : "memories"}
          </span>
        </span>
      ),
    },
    ...treeItems(g.tree, 1),
  ]);
}

function indent(depth: number): { paddingLeft: string } | undefined {
  return depth ? { paddingLeft: `${16 + depth * 20}px` } : undefined;
}

export function AssetTable({
  alias,
  items,
  caption,
  status,
}: {
  alias: string;
  items: AssetTableItem[];
  /** For screen readers: what the table lists */
  caption: string;
  /** The status cell: the Active switch or the status words */
  status: (row: AssetListRow) => ReactNode;
}) {
  return (
    <Table className="text-[13px]">
      <caption className="sr-only">{caption}</caption>
      <TableHeader>
        <TableRow className="hover:bg-transparent">
          <TableHead className="pl-4">Name</TableHead>
          <TableHead className="w-44">Status</TableHead>
          <TableHead className="w-20 text-right">Version</TableHead>
          <TableHead className="w-64 pr-4">Last change</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {items.map((it) =>
          it.kind === "group" ? (
            <TableRow key={it.key} className="bg-muted/50 hover:bg-muted/50">
              <TableCell colSpan={4} className="py-1.5 pl-4" style={indent(it.depth)}>
                {it.label}
              </TableCell>
            </TableRow>
          ) : (
            <TableRow key={it.row.assetId}>
              <TableCell className="max-w-0 min-w-52 py-2 pl-4" style={indent(it.depth)}>
                <span className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
                  <Link className="min-w-0 truncate rounded-sm leading-6 font-medium underline-offset-4 hover:underline" href={assetHref(alias, it.row.assetId)} title={it.row.name}>
                    {it.label}
                  </Link>
                  {it.row.managed.managed && it.row.managed.via === "self" ? <ManagedBadge managed={it.row.managed} compact /> : null}
                  <DeletedBadge deleted={it.row.deleted} />
                </span>
              </TableCell>
              <TableCell className="py-2">{status(it.row)}</TableCell>
              <TableCell className="py-2 text-right">{it.row.version !== null ? <VersionBadge version={it.row.version} /> : <span className="text-muted-foreground">-</span>}</TableCell>
              <TableCell className="py-2 pr-4">
                {it.row.lastChange ? (
                  <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
                    <SourceBadge source={it.row.lastChange.source} principal={it.row.lastChange.principal} recordedLabel={it.row.lastChange.label} />
                    <Time value={it.row.lastChange.at} format="datetime" className="text-xs text-muted-foreground" />
                  </span>
                ) : (
                  <span className="text-xs text-muted-foreground">Not recorded yet</span>
                )}
              </TableCell>
            </TableRow>
          ),
        )}
      </TableBody>
    </Table>
  );
}

/** The list rows of one plain type section. */
export function flatItems(rows: readonly AssetListRow[]): AssetTableItem[] {
  return rows.map((row) => ({ kind: "asset", row, depth: 0, label: row.name }));
}
