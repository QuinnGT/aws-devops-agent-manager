"use client";

import { ArrowRight, Layers, Search } from "lucide-react";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from "@/components/ui/command";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { commandIndexAction, type CommandIndex } from "./actions";
import { matchWords } from "./command-pages";
import { spaceBase } from "./nav";

/**
 * Search button plus the Cmd+K / Ctrl+K command dialog: pages and actions
 * (command-pages.ts, matched by everyday words such as "snapshot" or "undo"),
 * then asset types and asset names of the current space, loaded when the
 * dialog first opens.
 */
export function CommandSearch({ alias, spaceName }: { alias: string | null; spaceName: string | null }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [loaded, setLoaded] = useState<{ alias: string; index: CommandIndex } | null>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key.toLowerCase() === "k" && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        setOpen((o) => !o);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  useEffect(() => {
    if (!open || !alias || loaded?.alias === alias) return;
    let stop = false;
    void commandIndexAction(alias).then((index) => {
      if (!stop) setLoaded({ alias, index });
    });
    return () => {
      stop = true;
    };
  }, [open, alias, loaded?.alias]);

  const index = loaded?.alias === alias ? loaded.index : null;
  const go = (href: string) => {
    setOpen(false);
    router.push(href);
  };

  const description = spaceName ? `Search pages and assets in ${spaceName}` : "Search pages and assets";
  // The Search button is the dialog's trigger, so closing the dialog (also after Cmd+K) returns focus to it.
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <button
          type="button"
          className="flex h-8 w-full items-center gap-2 rounded-lg border border-sidebar-border bg-background px-2 text-[13px] text-muted-foreground transition-colors hover:bg-sidebar-accent hover:text-sidebar-accent-foreground"
        >
          <Search className="size-4" aria-hidden />
          Search
          <kbd className="ml-auto rounded border bg-background px-1.5 font-mono text-xs text-muted-foreground" aria-label="Command K">
            ⌘K
          </kbd>
        </button>
      </DialogTrigger>
      <DialogContent className="top-1/3 translate-y-0 overflow-hidden rounded-xl! p-0" showCloseButton={false}>
        <DialogHeader className="sr-only">
          <DialogTitle>Search</DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>
        <Command filter={matchWords}>
          <CommandInput placeholder={description} />
          <CommandList>
            {!alias ? (
              <CommandEmpty>Choose a space first to search its assets.</CommandEmpty>
            ) : !index ? (
              <div className="px-3 py-6 text-center text-sm text-muted-foreground">Loading…</div>
            ) : (
              <>
                <CommandEmpty>No page, asset or type matches. Try words such as instructions, history or settings.</CommandEmpty>
                <CommandGroup heading="Pages and actions">
                  {index.pages.map((p) => (
                    <CommandItem key={p.key} value={`page ${p.key} ${p.label}`} keywords={p.keywords} onSelect={() => go(p.href)}>
                      <ArrowRight aria-hidden />
                      <span className="grid min-w-0">
                        <span className="truncate">{p.label}</span>
                        <span className="text-xs text-muted-foreground">{p.hint}</span>
                      </span>
                    </CommandItem>
                  ))}
                </CommandGroup>
                <CommandGroup heading="Asset types">
                  {index.types.map((t) => (
                    <CommandItem key={t.assetType} value={`type ${t.label} ${t.assetType}`} onSelect={() => go(`${spaceBase(alias)}/assets?type=${encodeURIComponent(t.assetType)}`)}>
                      <Layers aria-hidden />
                      {t.label}
                      <span className="ml-auto text-xs text-muted-foreground tabular-nums">{t.count}</span>
                    </CommandItem>
                  ))}
                </CommandGroup>
                <CommandGroup heading="Assets">
                  {index.assets.map((a) => (
                    <CommandItem
                      key={a.assetId}
                      value={`${a.name} ${a.assetId}`}
                      keywords={a.keywords}
                      onSelect={() => go(`${spaceBase(alias)}/assets/${encodeURIComponent(a.assetId)}`)}
                    >
                      <span className="truncate">{a.name}</span>
                      <span className="ml-auto shrink-0 text-xs text-muted-foreground">{index.types.find((t) => t.assetType === a.assetType)?.label ?? a.assetType}</span>
                    </CommandItem>
                  ))}
                </CommandGroup>
              </>
            )}
          </CommandList>
        </Command>
      </DialogContent>
    </Dialog>
  );
}
