"use client";

import { ChevronsUpDown, Info, TriangleAlert } from "lucide-react";
import { useCallback, useId, useMemo, useRef, useState } from "react";
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList, CommandSeparator } from "@/components/ui/command";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { MODEL_ID_PATTERN, type ModelCatalog, type ModelOption } from "@/server/ai/models";

/**
 * Picks a Bedrock model or inference profile ID for audits (src/server/ai/models.ts).
 * A searchable list from GET /api/spaces/<alias>/models, loaded on first
 * open and grouped by provider, plus any typed ID that has the shape of a
 * model ID. When the list can't be read, one line says why and a typed ID
 * still works.
 *
 * The form posts `name` = the chosen ID, or "" for "use the default"
 * (`inheritLabel` says what that default is, and labels the empty choice in
 * the list and the button the same way).
 *
 * A chosen ID is checked against the list once it is loaded: one that isn't
 * in it gets a warning (it is still used as typed), and when the list could
 * not be read the picker says it can't check the ID.
 */
export interface ModelPickerProps {
  /** Form field name, e.g. "reviewModelId" or "inference.reviewModelId" */
  name: string;
  id?: string;
  /** Space alias, to list the models the space's read role can see */
  spaceAlias: string;
  defaultValue?: string | null;
  /** Shown when the field is empty and as the empty choice, e.g. "Space default: us.anthropic.example" or "No space default (each audit chooses)" */
  inheritLabel?: string;
  disabled?: boolean;
  invalid?: boolean;
  "aria-describedby"?: string;
  /** Called with the new value ("" for the default) whenever a choice is made */
  onChange?: (value: string) => void;
  /** The space's model list when the page already read it; otherwise it is loaded on first open */
  catalog?: ModelCatalog | null;
}

type Load = { status: "idle" | "loading" } | { status: "ready"; catalog: ModelCatalog } | { status: "failed"; error: string };

const LIST_FAILED = "The model list could not be read. Type a model ID.";

/** Models grouped by provider, in the catalogue's order (provider, then name). */
export function groupByProvider(models: readonly ModelOption[]): { provider: string; models: ModelOption[] }[] {
  const groups = new Map<string, ModelOption[]>();
  for (const m of models) {
    const key = m.provider ?? "Other";
    groups.set(key, [...(groups.get(key) ?? []), m]);
  }
  return [...groups].map(([provider, list]) => ({ provider, models: list }));
}

export type IdCheck = { tone: "warning" | "muted"; text: string } | null;

/** What the picker says about a chosen ID: nothing when the list has it or isn't loaded yet. Pure. */
export function checkModelId(value: string, load: { status: "idle" | "loading" } | { status: "ready"; catalog: Pick<ModelCatalog, "models" | "error"> } | { status: "failed" }): IdCheck {
  const v = value.trim();
  if (!v || load.status === "idle" || load.status === "loading") return null;
  if (load.status === "failed") return { tone: "muted", text: "Can't check this ID: the model list couldn't be read. It is used as typed." };
  if (load.status !== "ready") return null;
  if (load.catalog.models.some((m) => m.id === v)) return null;
  if (load.catalog.error) return { tone: "muted", text: "Can't check this ID: the model list couldn't be read. It is used as typed." };
  return { tone: "warning", text: "Not in the models this space can use. It is used as typed; check the ID before you start." };
}

/** The typed text as an ID to offer, or null when it isn't one or the list already has it. */
export function typedModelId(query: string, models: readonly ModelOption[]): string | null {
  const q = query.trim();
  if (!q || !MODEL_ID_PATTERN.test(q)) return null;
  return models.some((m) => m.id === q) ? null : q;
}

async function fetchCatalog(alias: string): Promise<Load> {
  try {
    const res = await fetch(`/api/spaces/${encodeURIComponent(alias)}/models`, { cache: "no-store" });
    const body = (await res.json().catch(() => null)) as (ModelCatalog & { error?: string | null }) | null;
    if (!res.ok || !body) return { status: "failed", error: body?.error ?? LIST_FAILED };
    return { status: "ready", catalog: body };
  } catch {
    return { status: "failed", error: LIST_FAILED };
  }
}

function KindText({ kind }: { kind: ModelOption["kind"] }) {
  return <span className="shrink-0 text-xs text-muted-foreground">{kind === "inference-profile" ? "Inference profile" : "Model"}</span>;
}

export function ModelPicker({ name, id, spaceAlias, defaultValue, inheritLabel, disabled, invalid, onChange, catalog, ...rest }: ModelPickerProps) {
  const fieldId = id ?? name;
  const listId = useId();
  const checkId = useId();
  const [value, setValue] = useState(defaultValue ?? "");
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [load, setLoad] = useState<Load>(catalog ? { status: "ready", catalog } : { status: "idle" });
  const started = useRef(!!catalog);

  const onOpenChange = useCallback(
    (next: boolean) => {
      setOpen(next);
      if (!next) setQuery("");
      if (next && !started.current) {
        started.current = true;
        setLoad({ status: "loading" });
        void fetchCatalog(spaceAlias).then(setLoad);
      }
    },
    [spaceAlias],
  );

  const models = useMemo(() => (load.status === "ready" ? load.catalog.models : []), [load]);
  const groups = useMemo(() => groupByProvider(models), [models]);
  const listError = load.status === "failed" ? load.error : load.status === "ready" ? load.catalog.error : null;
  const listDetail = load.status === "ready" ? (load.catalog.errorDetail ?? null) : null;
  const typed = typedModelId(query, models);
  const chosen = models.find((m) => m.id === value) ?? null;
  const badShape = query.trim() !== "" && !MODEL_ID_PATTERN.test(query.trim());
  const valueCheck = checkModelId(value, load);
  const typedCheck = typed ? checkModelId(typed, load) : null;
  const emptyLabel = inheritLabel ?? "Use the default";
  const describedBy = [rest["aria-describedby"], valueCheck ? checkId : null].filter(Boolean).join(" ") || undefined;

  const choose = (next: string) => {
    setValue(next);
    setOpen(false);
    setQuery("");
    onChange?.(next);
  };

  return (
    <>
      <Popover open={open} onOpenChange={onOpenChange}>
        <PopoverTrigger asChild>
          <Button
            type="button"
            id={fieldId}
            variant="outline"
            role="combobox"
            aria-expanded={open}
            aria-haspopup="listbox"
            aria-controls={open ? listId : undefined}
            aria-invalid={invalid || undefined}
            aria-describedby={describedBy}
            disabled={disabled}
            className="h-auto min-h-8 w-full justify-between gap-2 py-1 text-left font-normal whitespace-normal"
          >
            {value ? (
              <span className="min-w-0">
                {chosen ? <span className="block truncate">{chosen.label}</span> : null}
                <span className={cn("block font-mono text-xs break-all", chosen && "text-muted-foreground")}>{value}</span>
              </span>
            ) : (
              <span className="min-w-0 text-muted-foreground">{inheritLabel ?? "Choose a model"}</span>
            )}
            <ChevronsUpDown className="text-muted-foreground" aria-hidden />
          </Button>
        </PopoverTrigger>
        <PopoverContent align="start" className="w-(--radix-popover-trigger-width) min-w-80 gap-0 p-0">
          <Command loop>
            <CommandInput value={query} onValueChange={setQuery} placeholder="Search, or type a model or inference profile ID" aria-label="Search models or type an ID" spellCheck={false} autoComplete="off" />
            {load.status === "loading" ? (
              <p role="status" className="px-3 py-2 text-xs text-muted-foreground">
                Loading the models this space can use…
              </p>
            ) : null}
            {listError ? (
              <div role="status" className="px-3 py-2 text-xs">
                <p className="flex items-start gap-1.5 text-warning-fg">
                  <TriangleAlert className="mt-px size-3.5 shrink-0" aria-hidden />
                  <span>{listError}</span>
                </p>
                {listDetail ? (
                  <details className="mt-1 pl-5 text-muted-foreground">
                    <summary className="cursor-pointer">Details</summary>
                    <p className="mt-0.5 font-mono break-all">{listDetail}</p>
                  </details>
                ) : null}
              </div>
            ) : null}
            <CommandList id={listId} aria-label="Models">
              {query.trim() && !typed ? (
                <CommandEmpty className="px-3 py-3 text-left text-xs text-muted-foreground">
                  {badShape ? "A model ID uses letters, digits and . : / _ - only, with no spaces." : "No model matches. Type the full model or inference profile ID to use it."}
                </CommandEmpty>
              ) : null}
              {/* A typed ID comes first, so Enter takes it */}
              <CommandGroup forceMount>
                {typed ? (
                  <CommandItem forceMount value={`__typed__${typed}`} data-checked={value === typed} onSelect={() => choose(typed)}>
                    <span className="min-w-0">
                      <span className="block">Use this ID</span>
                      <span className="block font-mono text-xs break-all text-muted-foreground">{typed}</span>
                      {typedCheck ? <span className={cn("block text-xs", typedCheck.tone === "warning" ? "text-warning-fg" : "text-muted-foreground")}>{typedCheck.text}</span> : null}
                    </span>
                  </CommandItem>
                ) : null}
                <CommandItem forceMount value="__default__" data-checked={value === ""} onSelect={() => choose("")}>
                  <span className="min-w-0">
                    <span className="block">{emptyLabel}</span>
                  </span>
                </CommandItem>
              </CommandGroup>
              {groups.length ? <CommandSeparator /> : null}
              {groups.map((g) => (
                <CommandGroup key={g.provider} heading={g.provider}>
                  {g.models.map((m) => (
                    <CommandItem key={m.id} value={m.id} keywords={[m.label, g.provider]} data-checked={value === m.id} onSelect={() => choose(m.id)}>
                      <span className="min-w-0 flex-1">
                        <span className="block">{m.label}</span>
                        <span className="block font-mono text-xs break-all text-muted-foreground">{m.id}</span>
                      </span>
                      <KindText kind={m.kind} />
                    </CommandItem>
                  ))}
                </CommandGroup>
              ))}
            </CommandList>
          </Command>
        </PopoverContent>
      </Popover>
      {valueCheck ? (
        <p id={checkId} className={cn("flex items-start gap-1.5 text-xs", valueCheck.tone === "warning" ? "text-warning-fg" : "text-muted-foreground")}>
          {valueCheck.tone === "warning" ? <TriangleAlert className="mt-px size-3.5 shrink-0" aria-hidden /> : <Info className="mt-px size-3.5 shrink-0" aria-hidden />}
          <span>{valueCheck.text}</span>
        </p>
      ) : null}
      <input type="hidden" name={name} value={value} disabled={disabled} />
    </>
  );
}
