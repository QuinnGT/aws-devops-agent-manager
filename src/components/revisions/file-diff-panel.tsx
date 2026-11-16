"use client";

import { DiffCounts, UnifiedDiff } from "@/components/plans/unified-diff";
import { Card } from "@/components/ui/card";
import { Select, SelectContent, SelectGroup, SelectItem, SelectLabel, SelectTrigger, SelectValue } from "@/components/ui/select";
import type { FileDiff } from "@/server/assets/diff";
import { diffGroups, diffTotals, namesText } from "./editor-state";

const STATUS_WORD: Record<FileDiff["status"], string> = { added: "added", removed: "deleted", modified: "changed", unchanged: "no change", "not-comparable": "changed" };

const plural = (n: number, one: string, other: string) => `${n} ${n === 1 ? one : other}`;

/**
 * The Diff tab (revision-detail.md, option 1): one changed file at a time,
 * base against the branch head, chosen with the file Select or the tree.
 * The header counts the files the saves edited apart from the files the
 * build wrote (change record, validation result, indexes), so a small edit
 * reads as small. A file the tree points at that didn't change says so.
 */
export function FileDiffPanel({ title, files, builtPaths = [], current, onPick, dirty }: { title: string; files: FileDiff[]; builtPaths?: readonly string[]; current: string | null; onPick: (path: string) => void; dirty: boolean }) {
  const { edited, built } = diffGroups(files, builtPaths);
  const changed = [...edited, ...built];
  const shown = changed.find((f) => f.path === current) ?? changed[0] ?? null;
  const pointed = current && !changed.some((f) => f.path === current) ? current : null;
  const editedTotals = diffTotals(edited);
  const builtTotals = diffTotals(built);
  const item = (f: FileDiff) => (
    <SelectItem key={f.path} value={f.path} className="font-mono text-[13px]">
      {f.path} {f.added || f.removed ? `+${f.added} −${f.removed}` : `(${STATUS_WORD[f.status]})`}
    </SelectItem>
  );
  return (
    <Card className="gap-0 py-0">
      <div className="flex min-h-12 flex-wrap items-center justify-between gap-3 border-b px-4 py-2">
        <h2 className="text-sm font-semibold">{title}</h2>
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground tabular-nums">
          <span className="inline-flex items-center gap-1.5">
            Edited: {plural(edited.length, "file", "files")}
            <DiffCounts added={editedTotals.added} removed={editedTotals.removed} />
          </span>
          {built.length ? (
            <span className="inline-flex items-center gap-1.5">
              Built files: {built.length}
              <DiffCounts added={builtTotals.added} removed={builtTotals.removed} className="font-normal opacity-80" />
            </span>
          ) : null}
        </div>
      </div>
      {built.length ? (
        <p className="border-b px-4 py-2 text-xs text-muted-foreground">
          Built files are written by the build on every save ({namesText(built.map((f) => f.path.split("/").at(-1) ?? f.path))}), not by you.
        </p>
      ) : null}
      {dirty ? <p className="border-b px-4 py-2 text-xs text-muted-foreground">Unsaved edits are not in this diff. It compares the saved branch head with the base.</p> : null}
      {changed.length === 0 ? (
        <p className="px-4 py-3 text-[13px] text-muted-foreground">No changes against the base yet.</p>
      ) : (
        <>
          <div className="flex flex-wrap items-center gap-2 border-b px-4 py-2">
            <Select value={shown?.path ?? ""} onValueChange={onPick}>
              <SelectTrigger aria-label="Changed file" size="sm" className="max-w-full font-mono text-[13px]">
                <SelectValue placeholder="Choose a changed file" />
              </SelectTrigger>
              <SelectContent>
                {built.length && edited.length ? (
                  <>
                    <SelectGroup>
                      <SelectLabel>Edited</SelectLabel>
                      {edited.map(item)}
                    </SelectGroup>
                    <SelectGroup>
                      <SelectLabel>Built files</SelectLabel>
                      {built.map(item)}
                    </SelectGroup>
                  </>
                ) : (
                  changed.map(item)
                )}
              </SelectContent>
            </Select>
            {pointed ? <span className="text-xs text-muted-foreground">{pointed} has no change against the base.</span> : null}
          </div>
          {shown ? <UnifiedDiff file={shown} /> : null}
        </>
      )}
    </Card>
  );
}
