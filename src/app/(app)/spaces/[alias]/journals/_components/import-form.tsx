"use client";

import { Upload } from "lucide-react";
import { useActionState, useEffect, useId, useState } from "react";
import { toast } from "sonner";
import { Callout } from "@/components/common/callout";
import { DisabledReason } from "@/components/common/disabled-reason";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { uploadImportAction } from "../actions";
import { initialActionState } from "./action-state";

export function ImportForm({ alias, maxMb }: { alias: string; maxMb: number }) {
  const [state, action, pending] = useActionState(uploadImportAction.bind(null, alias), initialActionState);
  const [chosen, setChosen] = useState(false);
  const id = useId();

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
    <form action={action} onReset={() => setChosen(false)} className="space-y-3 px-4 py-4 text-sm">
      <div className="max-w-xl space-y-1">
        <Label htmlFor={`${id}-file`}>Journal file</Label>
        <Input
          id={`${id}-file`}
          type="file"
          name="file"
          accept=".md,.markdown,.zip"
          required
          aria-describedby={`${id}-help`}
          onChange={(e) => setChosen((e.target.files?.length ?? 0) > 0)}
        />
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
