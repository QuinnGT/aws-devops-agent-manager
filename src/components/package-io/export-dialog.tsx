"use client";

import { Download, Loader } from "lucide-react";
import { useEffect, useId, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { Callout } from "@/components/common/callout";
import { DisabledReason } from "@/components/common/disabled-reason";
import { formatRelative } from "@/components/common/time-format";
import { Button } from "@/components/ui/button";
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectGroup, SelectItem, SelectLabel, SelectSeparator, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import type { ExportPreview, TypeCount } from "@/server/package-io";
import type { ExportOptions } from "@/server/package-io/loaders";

/**
 * CONTRACT.
 *
 * "Export package" button that opens the package export dialog
 * (pages/package-import.md, "Export dialog"). The releases pages render it
 * with options from `loadExportOptions(space)`. Keep these props; add
 * optional props only.
 */
export interface ExportPackageButtonProps {
  alias: string;
  options: ExportOptions;
  /** Ref selected when the dialog opens: "HEAD", a commit hash or a release tag. */
  initialRef?: string;
  /** Button text: "Export package" on the releases list, "Export as package" on a release. */
  label: string;
  /** Button variant; default "outline". */
  variant?: "outline" | "default" | "ghost";
  /** Show each check error's code in mono after the sentence (Admins); otherwise only in a tooltip. */
  showCodes?: boolean;
}

const CUSTOM = "__commit";
const HEX = /^[0-9a-f]{7,64}$/i;

type PreviewState = { status: "idle" } | { status: "loading" } | { status: "ok"; preview: ExportPreview } | { status: "error"; message: string; field: "ref" | "layout" | null };

/** "1 instruction file, 5 skills" with the nouns from the server's policy. */
function countText(counts: readonly TypeCount[]): string {
  return counts.map((c) => `${c.count} ${c.noun}`).join(", ");
}

/** The source the dialog opens on: a known release or commit, HEAD, or a commit typed in. */
function initialSource(options: ExportOptions, initialRef: string | undefined): { source: string; commit: string } {
  const refs = options.refs;
  if (!refs || !initialRef || initialRef === "HEAD") return { source: "HEAD", commit: "" };
  if (refs.releases.some((r) => r.ref === initialRef)) return { source: initialRef, commit: "" };
  if (refs.commits.some((c) => c.ref === initialRef)) return { source: initialRef, commit: "" };
  if (HEX.test(initialRef)) return { source: CUSTOM, commit: initialRef };
  return { source: "HEAD", commit: "" };
}

/** Name from a Content-Disposition header, or null. */
function attachmentName(header: string | null): string | null {
  const m = header ? /filename="([^"]+)"/.exec(header) : null;
  return m?.[1] ?? null;
}

function ExportForm({ alias, options, initialRef, showCodes = false, onDone }: Omit<ExportPackageButtonProps, "label" | "variant"> & { onDone: () => void }) {
  const id = useId();
  const start = useMemo(() => initialSource(options, initialRef), [options, initialRef]);
  const [source, setSource] = useState(start.source);
  const [commit, setCommit] = useState(start.commit);
  const [layout, setLayout] = useState(options.defaultLayout ?? options.layouts[0]?.name ?? "");
  const [name, setName] = useState("");
  // Whether the person typed a name; while they haven't, each preview fills in the policy's name.
  const nameEdited = useRef(false);
  const [preview, setPreview] = useState<PreviewState>({ status: "idle" });
  const [downloading, setDownloading] = useState(false);
  const [downloadError, setDownloadError] = useState<string | null>(null);

  const ref = source === CUSTOM ? commit.trim() : source;
  const commitError = source === CUSTOM && commit.trim() !== "" && !HEX.test(commit.trim()) ? "Enter a commit hash: 7 to 64 characters, 0 to 9 and a to f." : null;
  const query = useMemo(() => {
    const q = new URLSearchParams();
    if (ref) q.set("ref", ref);
    if (layout) q.set("layout", layout);
    return q;
  }, [ref, layout]);
  const ready = options.repo.ok && !!ref && !commitError;

  useEffect(() => {
    if (!ready) return;
    const ctrl = new AbortController();
    const timer = setTimeout(
      async () => {
        setPreview({ status: "loading" });
        try {
          const res = await fetch(`/api/spaces/${encodeURIComponent(alias)}/packages/export/preview?${query}`, { signal: ctrl.signal });
          const data = (await res.json()) as { preview?: ExportPreview; error?: string; field?: "ref" | "layout" | null };
          if (res.ok && data.preview) {
            setPreview({ status: "ok", preview: data.preview });
            if (!nameEdited.current) setName(data.preview.packageName);
          } else setPreview({ status: "error", message: data.error ?? `The preview failed (${res.status}).`, field: data.field ?? null });
        } catch (err) {
          if (!ctrl.signal.aborted) setPreview({ status: "error", message: err instanceof Error ? "The app could not be reached. Try again." : String(err), field: null });
        }
      },
      source === CUSTOM ? 400 : 0,
    );
    return () => {
      ctrl.abort();
      clearTimeout(timer);
    };
  }, [alias, query, ready, source]);

  const download = async () => {
    setDownloading(true);
    setDownloadError(null);
    try {
      const q = new URLSearchParams(query);
      if (name.trim()) q.set("name", name.trim());
      const res = await fetch(`/api/spaces/${encodeURIComponent(alias)}/packages/export?${q}`);
      if (!res.ok) {
        setDownloadError((await res.text()) || `The download failed (${res.status}).`);
        return;
      }
      const blob = await res.blob();
      const fileName = attachmentName(res.headers.get("content-disposition")) ?? "package.zip";
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = fileName;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 10_000);
      toast.success(`Downloading ${fileName}`);
      onDone();
    } catch {
      setDownloadError("The app could not be reached. Try again.");
    } finally {
      setDownloading(false);
    }
  };

  const refs = options.refs;
  const head = refs?.head ?? null;
  const p = preview.status === "ok" ? preview.preview : null;
  const refFieldError = commitError ?? (preview.status === "error" && preview.field === "ref" ? preview.message : null);
  const layoutFieldError = preview.status === "error" && preview.field === "layout" ? preview.message : null;
  const blockReason = !options.repo.ok
    ? "This space has no history to export."
    : !ref
      ? "Enter a commit hash first."
      : refFieldError || layoutFieldError
        ? "Fix the source or the layout first."
        : preview.status === "loading" || preview.status === "idle"
          ? "Checking the package."
          : preview.status === "error"
            ? "The package could not be checked."
            : (p?.blockedReason ?? null);

  const downloadButton = (
    <Button type="button" size="sm" onClick={download} disabled={downloading}>
      {downloading ? <Loader className="motion-safe:animate-spin" aria-hidden /> : <Download aria-hidden />}
      {downloading ? "Preparing zip" : "Download zip"}
    </Button>
  );

  return (
    <>
      <div className="flex min-w-0 flex-col gap-4">
        {!options.repo.ok ? (
          <Callout tone="warning" title="Nothing to export yet">
            {options.repo.message}
          </Callout>
        ) : null}

        <div className="flex flex-col gap-1.5">
          <Label htmlFor={`${id}-source`}>Source</Label>
          <Select value={source} onValueChange={setSource} disabled={!refs}>
            <SelectTrigger id={`${id}-source`} className="w-full" aria-describedby={`${id}-source-help`} aria-invalid={!!refFieldError || undefined}>
              <SelectValue placeholder="No history yet" />
            </SelectTrigger>
            <SelectContent>
              {refs?.releases.length ? (
                <SelectGroup>
                  <SelectLabel>Releases</SelectLabel>
                  {refs.releases.map((r) => (
                    <SelectItem key={r.ref} value={r.ref}>
                      Release {r.label} <span className="font-mono text-xs text-muted-foreground">{r.ref}</span>
                    </SelectItem>
                  ))}
                </SelectGroup>
              ) : null}
              {head ? (
                <SelectGroup>
                  {refs?.releases.length ? <SelectSeparator /> : null}
                  <SelectItem value="HEAD">
                    Latest history commit ({head.label.slice(0, 7)}
                    {head.date ? `, ${formatRelative(head.date)}` : ""})
                  </SelectItem>
                </SelectGroup>
              ) : null}
              {refs?.commits.filter((c) => c.commit !== head?.commit).length ? (
                <SelectGroup>
                  <SelectSeparator />
                  <SelectLabel>Recent commits</SelectLabel>
                  {refs.commits
                    .filter((c) => c.commit !== head?.commit)
                    .map((c) => (
                      <SelectItem key={c.ref} value={c.ref}>
                        <span className="font-mono text-xs">{c.label.slice(0, 7)}</span>
                        <span className="max-w-[260px] truncate">{c.subject ?? ""}</span>
                      </SelectItem>
                    ))}
                </SelectGroup>
              ) : null}
              <SelectSeparator />
              <SelectItem value={CUSTOM}>A commit…</SelectItem>
            </SelectContent>
          </Select>
          {source === CUSTOM ? (
            <Input
              aria-label="Commit hash"
              className="font-mono text-xs"
              placeholder="Commit hash, for example 4f2a9c1"
              value={commit}
              onChange={(e) => setCommit(e.currentTarget.value)}
              aria-invalid={!!refFieldError || undefined}
              aria-describedby={refFieldError ? `${id}-source-error` : undefined}
              autoFocus
              spellCheck={false}
            />
          ) : null}
          {refFieldError ? (
            <p id={`${id}-source-error`} role="alert" className="text-xs text-destructive-fg">
              {refFieldError}
            </p>
          ) : null}
          <p id={`${id}-source-help`} className="text-xs text-muted-foreground">
            A release, the latest history commit, or a commit you enter.
          </p>
        </div>

        <div className="flex flex-col gap-1.5">
          <Label htmlFor={`${id}-layout`}>Layout</Label>
          <Select value={layout} onValueChange={setLayout}>
            <SelectTrigger id={`${id}-layout`} className="w-full" aria-describedby={`${id}-layout-help`} aria-invalid={!!layoutFieldError || undefined}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {options.layouts.map((l) => (
                <SelectItem key={l.name} value={l.name}>
                  {l.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          {layoutFieldError ? (
            <p role="alert" className="text-xs text-destructive-fg">
              {layoutFieldError}
            </p>
          ) : null}
          <p id={`${id}-layout-help`} className="text-xs text-muted-foreground">
            How the app arranges the package&apos;s folders.
          </p>
        </div>

        <div className="flex flex-col gap-1.5">
          <Label htmlFor={`${id}-name`}>Package name</Label>
          <Input
            id={`${id}-name`}
            value={name}
            maxLength={120}
            placeholder="Filled in from the source"
            onChange={(e) => {
              setName(e.currentTarget.value);
              nameEdited.current = true;
            }}
            aria-describedby={`${id}-name-help`}
            spellCheck={false}
          />
          <p id={`${id}-name-help`} className="text-xs text-muted-foreground">
            The zip&apos;s file name and top folder.
          </p>
        </div>

        {options.repo.ok ? (
          <div aria-live="polite" aria-busy={preview.status === "loading"}>
            {p ? (
              <dl className="grid grid-cols-[max-content_minmax(0,1fr)] gap-x-3 gap-y-1.5 text-[13px]">
                <dt className="text-muted-foreground">Includes</dt>
                <dd>
                  {p.included.reduce((n, c) => n + c.count, 0)} assets{p.included.length ? `: ${countText(p.included)}` : ""}
                </dd>
                {p.leftOut.length ? (
                  <>
                    <dt className="text-muted-foreground">Left out</dt>
                    <dd>{countText(p.leftOut)}. This layout has no folder for them.</dd>
                  </>
                ) : null}
                <dt className="text-muted-foreground">Built</dt>
                <dd>
                  {p.assetFolders ? (
                    <>
                      Each asset folder gets its <span className="font-mono text-xs">{p.assetFolders.descriptor}</span> with the asset ID and metadata
                      {p.assetFolders.index ? (
                        <>
                          , and <span className="font-mono text-xs">{p.assetFolders.index}</span> lists the folders
                        </>
                      ) : null}
                      . Memory indexes are rebuilt.
                    </>
                  ) : (
                    "Skill zips and memory indexes are rebuilt."
                  )}
                  {p.manifest ? (
                    <>
                      {" "}
                      Metadata the files can&apos;t carry goes to <span className="font-mono text-xs break-all">{p.manifest}</span>.
                    </>
                  ) : null}
                </dd>
              </dl>
            ) : preview.status === "loading" || preview.status === "idle" ? (
              <div className="space-y-2" aria-hidden>
                <Skeleton className="h-4 w-4/5" />
                <Skeleton className="h-4 w-3/5" />
                <Skeleton className="h-4 w-full" />
              </div>
            ) : preview.status === "error" && preview.field === null ? (
              <p role="alert" className="text-xs text-destructive-fg">
                {preview.message}
              </p>
            ) : null}
          </div>
        ) : null}

        {p?.blockedReason ? (
          <Callout tone="destructive" title="What fails the checks">
            <ul className="mt-1 max-h-36 list-disc space-y-0.5 overflow-y-auto pl-4" tabIndex={0} aria-label="Package check errors">
              {p.errors.map((e, i) => (
                <li key={`${i}:${e.code}`} className="break-words" title={e.code}>
                  {e.message}
                  {showCodes ? <span className="ml-1 font-mono text-xs text-muted-foreground">{e.code}</span> : null}
                </li>
              ))}
            </ul>
          </Callout>
        ) : null}
        {downloadError ? (
          <Callout tone="destructive" title="The download was refused" afterAction>
            <p className="break-words whitespace-pre-line">{downloadError}</p>
          </Callout>
        ) : null}
      </div>
      <DialogFooter className="items-center">
        <DialogClose asChild>
          <Button type="button" variant="outline" size="sm">
            Cancel
          </Button>
        </DialogClose>
        {blockReason ? (
          <DisabledReason reason={blockReason} className="justify-end">
            {downloadButton}
          </DisabledReason>
        ) : (
          downloadButton
        )}
      </DialogFooter>
    </>
  );
}

/** "Export package" / "Export as package": opens the export dialog. */
export function ExportPackageButton({ alias, options, initialRef, label, variant = "outline", showCodes = false }: ExportPackageButtonProps) {
  const [open, setOpen] = useState(false);
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button variant={variant} size="sm">
          <Download aria-hidden />
          {label}
        </Button>
      </DialogTrigger>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-[540px]">
        <DialogHeader>
          <DialogTitle>Export as package</DialogTitle>
          <DialogDescription>Download the space&apos;s assets as a zip, built from the saved history. Use it to copy them into a space this app can&apos;t change.</DialogDescription>
        </DialogHeader>
        {open ? <ExportForm alias={alias} options={options} initialRef={initialRef} showCodes={showCodes} onDone={() => setOpen(false)} /> : null}
      </DialogContent>
    </Dialog>
  );
}
