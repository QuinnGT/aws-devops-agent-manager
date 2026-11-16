"use client";

import { FileArchive, FolderOpen, Loader, Upload } from "lucide-react";
import { useRouter } from "next/navigation";
import { useId, useRef, useState, useTransition, type DragEvent } from "react";
import { Callout } from "@/components/common/callout";
import { DisabledReason } from "@/components/common/disabled-reason";
import { SectionCard } from "@/components/common/section-card";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { cn } from "@/lib/utils";
import { formatBytes } from "@/server/package-io/format";
import type { ValidationResult } from "@/server/validation/types";

type Chosen = { kind: "zip"; file: File } | { kind: "folder"; name: string; files: { file: File; path: string }[] };

interface Problem {
  title: string;
  body: string;
  results?: ValidationResult[];
}

export interface UploadLimits {
  maxZipBytes: number;
  maxEntries: number;
  maxTotalBytes: number;
}

/** The layout select's value for "detect from the files": the form sends no layout. */
export const DETECT_LAYOUT = "auto";

const chosenSize = (c: Chosen) => (c.kind === "zip" ? c.file.size : c.files.reduce((n, f) => n + f.file.size, 0));

/** The same caps the server applies, checked before anything is sent. */
function checkLimits(c: Chosen, limits: UploadLimits): Problem | null {
  const size = chosenSize(c);
  if (c.kind === "zip" && size > limits.maxZipBytes) return { title: "The package is too large", body: `It is ${formatBytes(size)}; the limit is ${formatBytes(limits.maxZipBytes)}.` };
  if (c.kind === "folder" && c.files.length > limits.maxEntries) {
    return { title: "The package is too large", body: `It has ${c.files.length.toLocaleString("en-US")} files; the limit is ${limits.maxEntries.toLocaleString("en-US")}.` };
  }
  if (c.kind === "folder" && size > limits.maxTotalBytes) return { title: "The package is too large", body: `Its files total ${formatBytes(size)}; the limit is ${formatBytes(limits.maxTotalBytes)}.` };
  return null;
}

/** Every file under a dropped folder, with its path from the folder's parent (like webkitRelativePath). */
async function readDroppedFolder(entry: FileSystemDirectoryEntry): Promise<{ file: File; path: string }[]> {
  const out: { file: File; path: string }[] = [];
  const walk = async (dir: FileSystemDirectoryEntry, prefix: string): Promise<void> => {
    const reader = dir.createReader();
    for (;;) {
      const batch = await new Promise<FileSystemEntry[]>((resolve, reject) => reader.readEntries(resolve, reject));
      if (batch.length === 0) break;
      for (const e of batch) {
        if (e.isDirectory) await walk(e as FileSystemDirectoryEntry, `${prefix}${e.name}/`);
        else if (e.isFile) out.push({ file: await new Promise<File>((resolve, reject) => (e as FileSystemFileEntry).file(resolve, reject)), path: `${prefix}${e.name}` });
      }
    }
  };
  await walk(entry, `${entry.name}/`);
  return out;
}

/**
 * The upload card (pages/package-import.md, "Upload"): layout, drop zone,
 * zip and folder pickers, the limits, and "Read package". It posts to the
 * upload Route Handler and goes to the result page.
 */
export function UploadForm({
  alias,
  layouts,
  defaultLayout,
  limits,
  limitsLine,
}: {
  alias: string;
  layouts: { name: string; label: string }[];
  defaultLayout: string | null;
  limits: UploadLimits;
  limitsLine: string;
}) {
  const router = useRouter();
  const id = useId();
  const zipInput = useRef<HTMLInputElement>(null);
  const folderInput = useRef<HTMLInputElement>(null);
  const [layout, setLayout] = useState(DETECT_LAYOUT);
  const [chosen, setChosen] = useState<Chosen | null>(null);
  const [problem, setProblem] = useState<Problem | null>(null);
  const [dragging, setDragging] = useState(false);
  const [pending, start] = useTransition();

  const choose = (c: Chosen | null) => {
    setChosen(c);
    setProblem(c ? checkLimits(c, limits) : null);
  };

  const onZip = (files: FileList | null) => {
    const f = files?.[0];
    if (f) choose({ kind: "zip", file: f });
  };

  const onFolder = (files: FileList | null) => {
    const list = [...(files ?? [])].map((file) => ({ file, path: file.webkitRelativePath || file.name }));
    if (list.length === 0) return;
    const name = list[0]!.path.split("/")[0] ?? "folder";
    choose({ kind: "folder", name, files: list });
  };

  const onDrop = async (e: DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    setDragging(false);
    const items = [...e.dataTransfer.items];
    const entry = items.length === 1 ? items[0]!.webkitGetAsEntry() : null;
    if (entry?.isDirectory) {
      try {
        const files = await readDroppedFolder(entry as FileSystemDirectoryEntry);
        if (files.length) choose({ kind: "folder", name: entry.name, files });
      } catch {
        setProblem({ title: "The folder could not be read", body: "Use Choose folder instead." });
      }
      return;
    }
    const files = [...e.dataTransfer.files];
    if (files.length === 1 && files[0]!.name.toLowerCase().endsWith(".zip")) choose({ kind: "zip", file: files[0]! });
    else setProblem({ title: "Drop one zip file or one folder", body: "Or use Choose zip or Choose folder." });
  };

  const submit = () => {
    if (!chosen || checkLimits(chosen, limits)) return;
    const form = new FormData();
    if (layout && layout !== DETECT_LAYOUT) form.set("layout", layout);
    if (chosen.kind === "zip") form.set("file", chosen.file, chosen.file.name);
    else {
      form.set("name", chosen.name);
      for (const f of chosen.files) {
        form.append("files", f.file, f.file.name);
        form.append("paths", f.path);
      }
    }
    start(async () => {
      setProblem(null);
      try {
        const res = await fetch(`/api/spaces/${encodeURIComponent(alias)}/packages/import`, { method: "POST", body: form });
        const data = (await res.json().catch(() => null)) as { importId?: string; error?: Problem } | null;
        if (res.ok && data?.importId) {
          router.push(`/spaces/${encodeURIComponent(alias)}/plans/import/${data.importId}`);
          return;
        }
        setProblem(data?.error ?? { title: "The upload failed", body: `The server answered ${res.status}. Try again.` });
      } catch {
        setProblem({ title: "The upload failed", body: "The app could not be reached. Check the connection and try again." });
      }
    });
  };

  const blocked = !chosen ? "Choose a zip or a folder first." : problem && checkLimits(chosen, limits) ? "Choose a smaller package." : null;
  const readButton = (
    <Button type="button" size="sm" onClick={submit} disabled={pending}>
      {pending ? <Loader className="motion-safe:animate-spin" aria-hidden /> : null}
      {pending ? "Reading package" : "Read package"}
    </Button>
  );

  return (
    <div className="space-y-3">
      {problem ? (
        <Callout tone="destructive" title={problem.title} afterAction>
          <p>{problem.body}</p>
          {problem.results?.length ? (
            <ul className="mt-1.5 space-y-1">
              {problem.results.slice(0, 20).map((r, i) => (
                <li key={`${i}:${r.code}`} className="break-words">
                  {r.message} <span className="font-mono text-xs text-muted-foreground">{r.code}</span>
                </li>
              ))}
            </ul>
          ) : null}
          {problem.results && problem.results.length > 20 ? <p className="mt-1 text-xs text-muted-foreground">and {problem.results.length - 20} more</p> : null}
        </Callout>
      ) : null}
      <SectionCard id={`${id}-h`} title="Upload">
        <div className="flex flex-col gap-4 p-4">
          <div className="flex flex-col gap-1.5">
            <Label id={`${id}-layout-label`} htmlFor={`${id}-layout`}>
              Layout
            </Label>
            <Select value={layout} onValueChange={setLayout} disabled={pending}>
              <SelectTrigger id={`${id}-layout`} className="w-full" aria-describedby={`${id}-layout-help`}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={DETECT_LAYOUT}>Detect from the files</SelectItem>
                {layouts.map((l) => (
                  <SelectItem key={l.name} value={l.name}>
                    {l.label}
                    {l.name === defaultLayout ? " (usual for this space)" : ""}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <p id={`${id}-layout-help`} className="text-xs text-muted-foreground">
              How the app reads the package&apos;s folders. Detect picks the layout that maps the most files to assets; you can read the package again with another one on the next page.
            </p>
          </div>

          <div
            className={cn(
              "flex flex-col items-center gap-2 rounded-lg border-2 border-dashed px-4 py-6 text-center transition-colors",
              dragging ? "border-ring bg-muted" : "border-muted-foreground/50 bg-muted/40",
            )}
            onDragOver={(e) => {
              e.preventDefault();
              setDragging(true);
            }}
            onDragLeave={() => setDragging(false)}
            onDrop={onDrop}
          >
            <Upload className="size-5 text-muted-foreground" aria-hidden />
            <p className="font-semibold">Drop a zip file or a package folder here</p>
            <p className="text-[13px] text-muted-foreground" aria-live="polite">
              {chosen ? (
                <>
                  <span className="font-mono text-xs text-foreground">{chosen.kind === "zip" ? chosen.file.name : `${chosen.name}/`}</span>
                  {" · "}
                  {chosen.kind === "folder" ? `${chosen.files.length.toLocaleString("en-US")} files · ` : null}
                  <span className="tabular-nums">{formatBytes(chosenSize(chosen))}</span>
                </>
              ) : (
                "or choose one"
              )}
            </p>
            <div className="flex flex-wrap justify-center gap-2">
              <Button type="button" variant="outline" size="sm" onClick={() => zipInput.current?.click()} disabled={pending}>
                <FileArchive aria-hidden />
                Choose zip
              </Button>
              <Button type="button" variant="outline" size="sm" onClick={() => folderInput.current?.click()} disabled={pending}>
                <FolderOpen aria-hidden />
                Choose folder
              </Button>
            </div>
            <p className="text-[13px] text-muted-foreground">{limitsLine}</p>
            <input
              ref={zipInput}
              type="file"
              accept=".zip,application/zip"
              className="sr-only"
              tabIndex={-1}
              aria-hidden
              onChange={(e) => {
                onZip(e.currentTarget.files);
                e.currentTarget.value = "";
              }}
            />
            <input
              ref={(el) => {
                folderInput.current = el;
                if (el) el.webkitdirectory = true;
              }}
              type="file"
              multiple
              className="sr-only"
              tabIndex={-1}
              aria-hidden
              onChange={(e) => {
                onFolder(e.currentTarget.files);
                e.currentTarget.value = "";
              }}
            />
          </div>

          <div>{blocked ? <DisabledReason reason={blocked}>{readButton}</DisabledReason> : readButton}</div>
        </div>
      </SectionCard>
    </div>
  );
}
