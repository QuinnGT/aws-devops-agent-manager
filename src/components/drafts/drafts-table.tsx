"use client";

import { GitPullRequest, Lock } from "lucide-react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useId, useMemo, useState, useTransition, type ReactNode } from "react";
import { toast } from "sonner";
import { ChangeChip } from "@/components/common/change-chip";
import { Checkbox } from "@/components/common/checkbox";
import { DisabledReason } from "@/components/common/disabled-reason";
import { EmptyState } from "@/components/common/empty-state";
import { StatusBadge } from "@/components/common/status-badge";
import type { ActionResult } from "@/components/plans/action-state";
import { useReturnFocus } from "@/components/plans/return-focus";
import { Segmented } from "@/components/plans/segmented";
import { defaultPlanTitle, draftChangeWord, validationSpec } from "@/components/plans/words";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button, buttonVariants } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { cn } from "@/lib/utils";
import type { DraftTableRow } from "@/server/drafts/loaders";
import { canSelect, createBlocker, hasCheckbox, headerState, pruneSelection, toggleAll, toggleOne } from "./selection";

const PAGE = 50;

/**
 * The "Open drafts" card (pages/drafts.md): Mine or Everyone, the table with
 * checkboxes on your own drafts that aren't in a plan, the selection bar with
 * "Create plan", and Discard.
 */
export function DraftsTable({
  base,
  who,
  counts,
  rows,
  saved,
  canCreatePlan,
  canDiscard,
  createPlan,
  discard,
}: {
  base: string;
  who: "mine" | "all";
  counts: { mine: number; all: number };
  rows: DraftTableRow[];
  /** The Saved cell per draft ID, rendered on the server with the viewer's time zone */
  saved: Record<string, ReactNode>;
  canCreatePlan: boolean;
  canDiscard: boolean;
  createPlan: (draftIds: string[], title: string) => Promise<ActionResult<{ planId: string }>>;
  discard: (draftId: string) => Promise<ActionResult>;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const [pending, startTransition] = useTransition();
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [title, setTitle] = useState("");
  const [titleEdited, setTitleEdited] = useState(false);
  const [limit, setLimit] = useState(PAGE);
  const [error, setError] = useState<string | null>(null);
  const [discarding, setDiscarding] = useState<DraftTableRow | null>(null);
  const titleId = useId();
  const discardFocus = useReturnFocus();

  // Drop selections that are no longer selectable after a refresh.
  const selected = useMemo(() => pruneSelection(picked, rows), [picked, rows]);
  const selectedRows = rows.filter((r) => selected.has(r.id));
  const shownTitle = titleEdited ? title : defaultPlanTitle(selectedRows.map((r) => r.name));
  const blocker = createBlocker(selectedRows, shownTitle);
  const header = headerState(selected, rows);
  const anySelectable = canCreatePlan && rows.some(canSelect);

  const onCreate = () =>
    startTransition(async () => {
      const r = await createPlan([...selected], shownTitle.trim());
      if (!r.ok) {
        setError(r.message);
        return;
      }
      router.push(`${base}/plans/${encodeURIComponent(r.planId)}`);
    });

  const onDiscard = (row: DraftTableRow) =>
    startTransition(async () => {
      const r = await discard(row.id);
      setDiscarding(null);
      if (!r.ok) {
        setError(r.message);
        return;
      }
      toast.success(`Draft of ${row.name} discarded`);
      router.refresh();
    });

  const clear = () => {
    setPicked(new Set());
    setTitleEdited(false);
    setTitle("");
    setError(null);
  };

  return (
    <Card className="gap-0 py-0" role="region" aria-labelledby="open-drafts-h">
      <div className="flex min-h-12 flex-wrap items-center justify-between gap-3 border-b px-4 py-2">
        <h2 id="open-drafts-h" className="text-sm font-semibold">
          Open drafts
        </h2>
        <Segmented
          label="Show drafts by"
          value={who}
          onChange={(v) => router.replace(v === "all" ? pathname : `${pathname}?who=mine`, { scroll: false })}
          options={[
            { value: "mine", label: `Mine ${counts.mine}` },
            { value: "all", label: `Everyone ${counts.all}` },
          ]}
        />
      </div>

      {rows.length === 0 ? (
        <EmptyState
          title={who === "mine" ? "No drafts yet" : "No open drafts in this space"}
          action={
            <Link href={`${base}/assets`} className={buttonVariants({ variant: "outline", size: "sm" })}>
              Open assets
            </Link>
          }
        >
          Open an asset and choose Edit as draft. Drafts stay in this app until a plan applies them.
        </EmptyState>
      ) : (
        <Table>
          <TableHeader className="bg-muted/50">
            <TableRow className="hover:bg-transparent">
              {canCreatePlan ? (
                <TableHead className="w-12 pl-3">
                  {anySelectable ? (
                    <Checkbox checked={header} onCheckedChange={() => setPicked(toggleAll(selected, rows))} aria-label="Select all drafts you can add to a plan" />
                  ) : (
                    <span className="sr-only">Select</span>
                  )}
                </TableHead>
              ) : null}
              <TableHead className={cn("text-[13px] text-muted-foreground", !canCreatePlan && "pl-4")}>Draft</TableHead>
              <TableHead className="text-[13px] text-muted-foreground">Change</TableHead>
              <TableHead className="text-[13px] text-muted-foreground">Based on</TableHead>
              <TableHead className="text-[13px] text-muted-foreground">Validation</TableHead>
              <TableHead className="text-[13px] text-muted-foreground">Plan</TableHead>
              <TableHead className="text-[13px] text-muted-foreground">Author</TableHead>
              <TableHead className="text-right text-[13px] text-muted-foreground">Saved</TableHead>
              <TableHead className="pr-4">
                <span className="sr-only">Actions</span>
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.slice(0, limit).map((r) => {
              const checked = selected.has(r.id);
              const word = draftChangeWord(r.change);
              return (
                <TableRow key={r.id} className={cn("align-top", checked && "bg-foreground/3")}>
                  {canCreatePlan ? (
                    <TableCell className="py-2 pl-3">
                      {hasCheckbox(r) ? (
                        <Checkbox
                          checked={checked}
                          disabled={!canSelect(r)}
                          onCheckedChange={(on) => setPicked(toggleOne(selected, r.id, on === true))}
                          aria-label={`Select ${r.name}`}
                          aria-describedby={r.assetDeleted ? `deleted-${r.id}` : undefined}
                        />
                      ) : null}
                    </TableCell>
                  ) : null}
                  <TableCell className={cn("min-w-48 py-2.5 whitespace-normal", !canCreatePlan && "pl-4")}>
                    {r.assetId ? (
                      <Link
                        href={`${base}/assets/${encodeURIComponent(r.assetId)}/draft${r.mine ? "" : `?draft=${encodeURIComponent(r.id)}`}`}
                        className="inline-flex min-h-6 items-center rounded-sm font-semibold break-words underline-offset-4 hover:underline"
                      >
                        {r.name}
                      </Link>
                    ) : (
                      <span className="font-semibold">{r.name}</span>
                    )}
                    <p className="text-xs text-muted-foreground">
                      {r.parentName ? `${r.typeLabel} in ${r.parentName}` : r.typeLabel}
                      {r.alsoNote ? ` · ${r.alsoNote}` : null}
                    </p>
                    {r.assetDeleted && r.mine && !r.plan ? (
                      <p id={`deleted-${r.id}`} className="mt-0.5 flex items-center gap-1 text-xs text-muted-foreground">
                        <Lock className="size-3.5" aria-hidden />
                        The asset was deleted from the space.
                      </p>
                    ) : null}
                  </TableCell>
                  <TableCell className="py-3">
                    {r.assetDeleted ? <span className="text-[13px] font-medium text-destructive-fg">Asset deleted</span> : <ChangeChip word={word.word} label={word.label} />}
                  </TableCell>
                  <TableCell className="py-3">
                    <span className="font-mono text-xs">{r.baseVersion === null ? "new" : `v${r.baseVersion}`}</span>
                    {r.liveMoved && r.liveVersion !== null ? <ChangeChip word="skip-live-changed" label={`Live is v${r.liveVersion}`} className="mt-0.5 flex" /> : null}
                  </TableCell>
                  <TableCell className="py-2.5">
                    <StatusBadge {...validationSpec(r.validation)} />
                  </TableCell>
                  <TableCell className="py-3 whitespace-normal">
                    {r.plan ? (
                      <Link href={`${base}/plans/${r.plan.id}`} className="inline-flex min-h-6 items-center rounded-sm text-[13px] underline underline-offset-2">
                        {r.plan.title}
                      </Link>
                    ) : (
                      <span className="text-[13px] text-muted-foreground">Not in a plan</span>
                    )}
                  </TableCell>
                  <TableCell className="py-3 text-[13px]">{r.authorName}</TableCell>
                  <TableCell className="py-3 text-right text-[13px]">{saved[r.id]}</TableCell>
                  <TableCell className="py-2 pr-4 text-right">
                    {canDiscard && r.mine && !r.plan ? (
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => {
                          discardFocus.remember();
                          setDiscarding(r);
                        }}
                        disabled={pending}
                        aria-label={`Discard your draft of ${r.name}`}
                      >
                        Discard
                      </Button>
                    ) : null}
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      )}
      {rows.length > limit ? (
        <div className="flex justify-center border-t px-4 py-2">
          <Button variant="ghost" size="sm" onClick={() => setLimit((n) => n + PAGE)}>
            Show more
          </Button>
        </div>
      ) : null}

      {selected.size > 0 ? (
        <div className="flex flex-wrap items-center gap-x-4 gap-y-2 border-t bg-muted px-4 py-2.5" role="group" aria-label="Selected drafts">
          <span className="text-[13px] font-semibold tabular-nums" aria-live="polite">
            {selected.size} {selected.size === 1 ? "draft" : "drafts"} selected
          </span>
          <div className="flex min-w-64 flex-1 items-center gap-2">
            <Label htmlFor={titleId} className="shrink-0 text-[13px]">
              Plan title
            </Label>
            <Input
              id={titleId}
              value={shownTitle}
              onChange={(e) => {
                setTitleEdited(true);
                setTitle(e.target.value);
              }}
              className="h-8 bg-background text-[13px] md:text-[13px]"
              maxLength={200}
            />
          </div>
          {blocker ? (
            <DisabledReason reason={blocker}>
              <Button size="sm">
                <GitPullRequest aria-hidden />
                Create plan from {selected.size} {selected.size === 1 ? "draft" : "drafts"}
              </Button>
            </DisabledReason>
          ) : (
            <Button size="sm" onClick={onCreate} disabled={pending}>
              <GitPullRequest aria-hidden />
              Create plan from {selected.size} {selected.size === 1 ? "draft" : "drafts"}
            </Button>
          )}
          <Button variant="ghost" size="sm" onClick={clear}>
            Clear selection
          </Button>
        </div>
      ) : null}
      {error ? (
        <p role="alert" className="border-t px-4 py-2 text-[13px] text-destructive-fg">
          {error}
        </p>
      ) : null}
      {canCreatePlan ? (
        <p className="border-t px-4 py-2.5 text-xs text-muted-foreground">
          You can add your own drafts that aren&apos;t in a plan yet. Creating the plan checks them against the live space, then opens the plan for review.
        </p>
      ) : null}

      <AlertDialog open={discarding !== null} onOpenChange={(open) => !open && setDiscarding(null)}>
        <AlertDialogContent onCloseAutoFocus={discardFocus.onCloseAutoFocus}>
          <AlertDialogHeader>
            <AlertDialogTitle>Discard your draft of {discarding?.name}?</AlertDialogTitle>
            <AlertDialogDescription>Your edits are deleted. The live space is not affected.</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction variant="destructive" onClick={() => discarding && onDiscard(discarding)}>
              Discard draft
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Card>
  );
}
