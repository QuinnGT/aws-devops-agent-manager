"use client";

import { Check, CircleX, GitCommitHorizontal } from "lucide-react";
import { useState, type ReactNode } from "react";
import { EmptyState } from "@/components/common/empty-state";
import { StatusBadge } from "@/components/common/status-badge";
import { formatTime, type ViewerZone } from "@/components/common/time-format";
import { DiffCounts, UnifiedDiff } from "@/components/plans/unified-diff";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import type { FileDiff } from "@/server/assets/diff";

export interface SaveRow {
  id: string;
  number: number;
  message: string;
  commit: string;
  author: string;
  authorName: string | null;
  createdAt: string;
  files: FileDiff[];
  added: number;
  removed: number;
  findings: { id: string; label: string; href: string | null }[];
  unlinkedReason: string | null;
  buildStatus: "passed" | "failed";
}

const PASSED = { tone: "success" as const, icon: Check, label: "Build passed" };
const FAILED = { tone: "destructive" as const, icon: CircleX, label: "Build failed" };

/**
 * The Saves tab: option 2's change list (revision-detail.md). One row per
 * save, newest first: the message, files and +/− counts, author and time,
 * the linked findings as chips, the build result, and "Diff", which opens
 * the save's own diff inline.
 */
export function SavesList({ saves, zone, started, emptyAction }: { saves: SaveRow[]; zone: ViewerZone; started: string; emptyAction: ReactNode }) {
  const [open, setOpen] = useState<string | null>(null);
  return (
    <Card className="gap-0 py-0" role="region" aria-labelledby="rev-saves-h">
      <div className="flex min-h-12 items-center justify-between gap-3 border-b px-4 py-2">
        <h2 id="rev-saves-h" className="text-sm font-semibold">
          Saves
        </h2>
        <span className="text-xs text-muted-foreground tabular-nums">{saves.length}</span>
      </div>
      {saves.length === 0 ? (
        <EmptyState title="No changes yet" action={emptyAction ?? undefined}>
          Edit a file and save it with the findings it addresses.
        </EmptyState>
      ) : (
        <ol>
          {saves.map((s) => {
            const expanded = open === s.id;
            const panel = `save-diff-${s.id}`;
            return (
              <li key={s.id} className="border-b px-4 py-3 last:border-b-0">
                <div className="grid grid-cols-[16px_minmax(0,1fr)] gap-x-2.5 gap-y-1 sm:grid-cols-[16px_minmax(0,1fr)_auto]">
                  <GitCommitHorizontal className="mt-0.5 size-4 text-muted-foreground" aria-hidden />
                  <div className="min-w-0">
                    <p className="text-sm font-semibold break-words">{s.message}</p>
                    <p className="text-xs text-muted-foreground">
                      {s.files.length} {s.files.length === 1 ? "file" : "files"} · <DiffCounts added={s.added} removed={s.removed} className="text-xs" /> · {s.authorName ?? s.author} · {formatTime(s.createdAt, "datetime", zone)}
                      <span className="font-mono"> · {s.commit.slice(0, 7)}</span>
                    </p>
                    {s.findings.length ? (
                      <ul className="mt-1.5 flex flex-wrap gap-1.5" aria-label="Linked findings">
                        {s.findings.map((f) => (
                          <li key={f.id}>
                            {f.href ? (
                              <a href={f.href} className="inline-flex min-h-6 items-center rounded-md border bg-muted/40 px-2 text-xs hover:underline">
                                {f.label}
                              </a>
                            ) : (
                              <span className="inline-flex min-h-6 items-center rounded-md border bg-muted/40 px-2 text-xs">{f.label}</span>
                            )}
                          </li>
                        ))}
                      </ul>
                    ) : s.unlinkedReason ? (
                      <p className="mt-1 text-xs text-muted-foreground">Not linked to a finding: {s.unlinkedReason}</p>
                    ) : null}
                  </div>
                  <div className="col-start-2 flex items-center gap-2 sm:col-start-3 sm:row-start-1 sm:self-start">
                    <StatusBadge {...(s.buildStatus === "passed" ? PASSED : FAILED)} />
                    <Button variant="ghost" size="sm" aria-expanded={expanded} aria-controls={panel} onClick={() => setOpen(expanded ? null : s.id)}>
                      {expanded ? "Hide diff" : "Diff"}
                    </Button>
                  </div>
                </div>
                {expanded ? (
                  <div id={panel} className="mt-3 space-y-3">
                    {s.files.map((f) => (
                      <div key={f.path} className="overflow-hidden rounded-md border">
                        <div className="flex flex-wrap items-center justify-between gap-2 border-b bg-muted/40 px-3 py-1.5">
                          <span className="font-mono text-xs break-all">{f.path}</span>
                          {f.status === "added" ? <span className="text-xs text-success-fg">New file</span> : f.status === "removed" ? <span className="text-xs text-destructive-fg">Deleted</span> : <DiffCounts added={f.added} removed={f.removed} />}
                        </div>
                        <UnifiedDiff file={f} label={`Diff of ${f.path} in save ${s.number}`} />
                      </div>
                    ))}
                  </div>
                ) : null}
              </li>
            );
          })}
        </ol>
      )}
      <p className="border-t px-4 py-2.5 text-xs text-muted-foreground">{started}</p>
    </Card>
  );
}
