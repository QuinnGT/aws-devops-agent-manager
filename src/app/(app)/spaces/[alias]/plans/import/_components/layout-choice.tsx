"use client";

import { Loader, RotateCcw } from "lucide-react";
import { useActionState, useId, useState } from "react";
import { DisabledReason } from "@/components/common/disabled-reason";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import type { LayoutCandidate } from "@/server/package-io/types";
import { changeImportLayoutAction, type LayoutChoiceState } from "../[importId]/actions";

/**
 * The layout card on the mapping result: how well each layout maps the
 * upload (detection ranks them by files mapped to assets), which one the
 * import uses, and "Read again" with another one while no plan exists.
 */
export function LayoutChoice({
  alias,
  importId,
  current,
  choice,
  candidates,
  disabledReason,
}: {
  alias: string;
  importId: string;
  current: string;
  choice: "detected" | "chosen" | null;
  candidates: LayoutCandidate[];
  /** Why the layout can't change (a plan exists, the upload is gone, no permission), or null */
  disabledReason: string | null;
}) {
  const id = useId();
  const [state, action, pending] = useActionState<LayoutChoiceState, FormData>(changeImportLayoutAction.bind(null, alias), { error: null });
  const others = candidates.filter((c) => c.layout !== current);
  const [layout, setLayout] = useState(others[0]?.layout ?? "");
  const best = candidates[0]?.layout ?? null;
  const button = (
    <Button type="submit" variant="outline" size="sm" disabled={pending || !layout}>
      {pending ? <Loader className="motion-safe:animate-spin" aria-hidden /> : <RotateCcw aria-hidden />}
      {pending ? "Reading package" : "Read again"}
    </Button>
  );
  return (
    <div className="flex flex-col gap-3 px-4 py-3 text-[13px]">
      <p className="text-muted-foreground">
        {choice === "detected"
          ? "Detected: the layout that maps the most files to assets."
          : choice === "chosen"
            ? best && best !== current
              ? "Chosen when the package was read. Another layout maps more files."
              : "Chosen when the package was read."
            : "The layout the package was read with."}
      </p>
      {candidates.length ? (
        <ul className="flex flex-col gap-1.5">
          {candidates.map((c) => (
            <li key={c.layout} className="flex flex-col">
              <span className={c.layout === current ? "font-semibold" : undefined}>
                {c.label}
                {c.layout === current ? <span className="font-normal text-muted-foreground"> (used)</span> : null}
              </span>
              <span className="text-xs text-muted-foreground tabular-nums">
                {c.assetFiles} {c.assetFiles === 1 ? "file" : "files"} in {c.assets} {c.assets === 1 ? "asset" : "assets"}
                {c.unmappedFiles ? `, ${c.unmappedFiles} not mapped` : ""}
              </span>
            </li>
          ))}
        </ul>
      ) : null}
      {others.length ? (
        <form action={action} className="flex flex-col gap-2">
          <input type="hidden" name="importId" value={importId} />
          <input type="hidden" name="layout" value={layout} />
          <div className="flex flex-col gap-1.5">
            <Label htmlFor={`${id}-layout`}>Read with another layout</Label>
            <Select value={layout} onValueChange={setLayout} disabled={!!disabledReason || pending}>
              <SelectTrigger id={`${id}-layout`} className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {others.map((c) => (
                  <SelectItem key={c.layout} value={c.layout}>
                    {c.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div>{disabledReason ? <DisabledReason reason={disabledReason}>{button}</DisabledReason> : button}</div>
          {state.error ? (
            <p role="alert" className="text-xs text-destructive-fg">
              {state.error}
            </p>
          ) : null}
        </form>
      ) : null}
    </div>
  );
}
