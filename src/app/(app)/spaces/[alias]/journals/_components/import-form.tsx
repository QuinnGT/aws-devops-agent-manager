"use client";

import { FileUp, Upload } from "lucide-react";
import { useActionState, useEffect, useId, useRef, useState } from "react";
import { toast } from "sonner";
import { Callout } from "@/components/common/callout";
import { DisabledReason } from "@/components/common/disabled-reason";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { uploadImportAction } from "../actions";
import { initialActionState } from "./action-state";

export function ImportForm({ alias, maxMb }: { alias: string; maxMb: number }) {
  const [state, action, pending] = useActionState(uploadImportAction.bind(null, alias), initialActionState);
  const [fileName, setFileName] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const id = useId();
  const chosen = fileName !== null;

  useEffect(() => {
    if (state.status === "ok") toast.success(state.message);
  }, [state]);

  const submit = (
    <Button type="submit" disabled={pending}>
      <Upload aria-hidden />
      {pending ? "Uploading…" : "Upload and import"}
    </Button>
  );

  return (
    <form action={action} onReset={() => setFileName(null)} className="space-y-3 px-4 py-4 text-sm">
      <div className="max-w-xl space-y-1.5">
        <Label htmlFor={`${id}-file`}>Journal file</Label>
        {/* Same picker as the other uploads: the native control is hidden behind an outline button. */}
        <div className="flex flex-wrap items-center gap-2">
          <input
            ref={fileRef}
            id={`${id}-file`}
            type="file"
            name="file"
            accept=".md,.markdown,.zip"
            required
            className="sr-only"
            aria-describedby={`${id}-help`}
            onChange={(e) => setFileName(e.target.files?.[0]?.name ?? null)}
          />
          <Button type="button" variant="outline" size="sm" disabled={pending} onClick={() => fileRef.current?.click()}>
            <FileUp aria-hidden />
            Choose file
          </Button>
          <span className={`min-w-0 truncate text-xs text-muted-foreground ${chosen ? "font-mono" : ""}`}>{fileName ?? "No file chosen"}</span>
        </div>
        <p id={`${id}-help`} className="text-xs text-muted-foreground">
          One markdown journal (.md) or a zip of journals, up to {maxMb} MB.
        </p>
      </div>
      {state.status === "error" ? (
        <Callout tone="destructive" title="The upload wasn't imported" afterAction>
          {state.message}
        </Callout>
      ) : null}
      {chosen ? submit : <DisabledReason reason="Choose a .md or .zip file first.">{submit}</DisabledReason>}
    </form>
  );
}
