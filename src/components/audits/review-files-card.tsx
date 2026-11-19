"use client";

import { CircleCheck, CircleX, Download, FileUp, TriangleAlert } from "lucide-react";
import { useRouter } from "next/navigation";
import { useId, useRef, useState } from "react";
import { Callout } from "@/components/common/callout";
import { DisabledReason } from "@/components/common/disabled-reason";
import { Button, buttonVariants } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Progress } from "@/components/ui/progress";
import type { ImportReport, ImportResult } from "@/server/audits/handoff-import";
import { plural } from "./words";

export interface ReviewFilesCardProps {
  alias: string;
  auditId: string;
  /** Set on an investigation's page: the files and the import are for that investigation */
  itemId?: string;
  /** The investigation's name, for its own page */
  incident?: string;
  /** Investigations waiting for a review file, for the audit's card */
  waiting?: number;
  download: { enabled: boolean; reason: string | null };
  import: { enabled: boolean; reason: string | null };
  maxUploadMb: number;
}

interface Problem {
  title: string;
  body: string;
  field?: string;
}

/** What the import did with one file, in a sentence for the list. */
export function resultText(r: ImportResult): { tone: "success" | "warning" | "destructive"; title: string; body: string | null } {
  const name = r.incidentId ?? r.path;
  if (r.status === "refused") return { tone: "destructive", title: r.incidentId ? `${r.incidentId}: refused` : `${r.path}: refused`, body: r.reason };
  const parts = [plural(r.findings, "finding")];
  if (r.replaced) parts.push(r.carried ? `replaced the earlier review, ${plural(r.carried, "decision")} kept` : "replaced the earlier review");
  const failed = r.citations?.failed ?? 0;
  const note = [failed ? `${plural(failed, "citation")} failed the check, and the findings that rely on them are flagged for a person to read.` : null, r.note].filter(Boolean).join(" ");
  return { tone: failed ? "warning" : "success", title: `${name}: imported, ${parts.join(", ")}`, body: note || null };
}

/**
 * Review files of a hand-off audit (pages/audit-detail.md, "Review files"): one
 * zip of review folders to download, and the import of the reviews written from
 * them. On an investigation's page the same card covers that investigation. The
 * import posts to the review-files route, which checks every file; this card
 * only lists what happened to each.
 */
export function ReviewFilesCard(p: ReviewFilesCardProps) {
  const router = useRouter();
  const ids = useId();
  const fileRef = useRef<HTMLInputElement>(null);
  const [reviewer, setReviewer] = useState("");
  const [files, setFiles] = useState<File[]>([]);
  const [uploading, setUploading] = useState<number | null>(null);
  const [problem, setProblem] = useState<Problem | null>(null);
  const [report, setReport] = useState<ImportReport | null>(null);
  const single = !!p.itemId;
  const base = `/api/spaces/${encodeURIComponent(p.alias)}/audits/${p.auditId}${p.itemId ? `/items/${p.itemId}` : ""}/review-files`;

  function send() {
    setProblem(null);
    setReport(null);
    const form = new FormData();
    form.append("reviewer", reviewer);
    for (const f of files) form.append("files", f, f.name);
    const xhr = new XMLHttpRequest();
    xhr.open("POST", base);
    xhr.upload.onprogress = (e) => e.lengthComputable && setUploading(Math.round((e.loaded / e.total) * 100));
    xhr.onerror = () => {
      setUploading(null);
      setProblem({ title: "The upload failed", body: "The connection to the app was lost. Try again." });
    };
    xhr.onload = () => {
      setUploading(null);
      let body: { report?: ImportReport; error?: Problem } = {};
      try {
        body = JSON.parse(xhr.responseText) as typeof body;
      } catch {
        /* not JSON */
      }
      if (xhr.status === 200 && body.report) {
        setReport(body.report);
        setFiles([]);
        if (fileRef.current) fileRef.current.value = "";
        router.refresh();
      } else setProblem(body.error ?? { title: "The upload failed", body: "Try again." });
    };
    setUploading(0);
    xhr.send(form);
  }

  const downloadButton = (
    <Button type="button" variant="outline" size="sm">
      <Download aria-hidden />
      {single ? "Download review files" : "Download all review files"}
    </Button>
  );
  const importReason = !p.import.enabled ? p.import.reason : !reviewer.trim() ? "Enter who or what wrote the reviews first." : !files.length ? "Choose a file first." : null;
  const importButton = (
    <Button type="button" size="sm" onClick={send} disabled={uploading !== null}>
      <FileUp aria-hidden />
      {single ? "Import review" : "Import reviews"}
    </Button>
  );
  const fieldProblem = problem?.field === "reviewer" ? problem.body : null;

  return (
    <section aria-labelledby={`${ids}-h`} className="rounded-xl border bg-card text-card-foreground">
      <div className="flex min-h-12 flex-wrap items-center justify-between gap-3 border-b px-4 py-2">
        <h2 id={`${ids}-h`} className="text-sm font-semibold">
          Review files
        </h2>
        {!single && p.waiting !== undefined ? <span className="text-xs text-muted-foreground">{plural(p.waiting, "investigation")} waiting for a review file</span> : null}
      </div>
      <div className="space-y-4 px-4 py-3 text-[13px]">
        <p className="max-w-[80ch] text-muted-foreground">
          {single
            ? `The files for ${p.incident ?? "this investigation"} hold its journal, the brief and a README that says how to run them. Run them with an agent your company has approved, such as the Kiro CLI or Claude Code, then import the review.json it writes.`
            : "Each investigation gets a folder with its journal, the brief and a README that says how to run them. Run the folders with an agent your company has approved, such as the Kiro CLI or Claude Code, then import the reviews as a zip of the folders."}{" "}
          The files contain journal text from this space.
        </p>
        <div>
          {p.download.enabled ? (
            <a href={base} download className={buttonVariants({ variant: "outline", size: "sm" })}>
              <Download aria-hidden />
              {single ? "Download review files" : "Download all review files"}
            </a>
          ) : (
            <DisabledReason reason={p.download.reason}>{downloadButton}</DisabledReason>
          )}
        </div>

        <div className="space-y-3 border-t pt-3">
          <h3 className="text-[13px] font-semibold">{single ? "Import the review" : "Import reviews"}</h3>
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor={`${ids}-reviewer`}>Reviewer</Label>
              <Input
                id={`${ids}-reviewer`}
                value={reviewer}
                maxLength={200}
                placeholder="Claude Code, Opus 5.5"
                onChange={(e) => {
                  setReviewer(e.target.value);
                  if (problem?.field === "reviewer") setProblem(null);
                }}
                disabled={!p.import.enabled || uploading !== null}
                aria-invalid={fieldProblem ? true : undefined}
                aria-describedby={`${ids}-reviewer-help${fieldProblem ? ` ${ids}-reviewer-err` : ""}`}
              />
              <p id={`${ids}-reviewer-help`} className="text-xs text-muted-foreground">
                Who or what wrote the reviews. It is shown with each review.
              </p>
              {fieldProblem ? (
                <p id={`${ids}-reviewer-err`} role="alert" className="text-xs text-destructive-fg">
                  {fieldProblem}
                </p>
              ) : null}
            </div>
            <div className="space-y-1.5">
              <Label htmlFor={`${ids}-file`}>{single ? "review.json" : "Zip of the review folders"}</Label>
              <div className="flex flex-wrap items-center gap-2">
                <input
                  ref={fileRef}
                  id={`${ids}-file`}
                  type="file"
                  className="sr-only"
                  accept={single ? ".json,.zip,application/json,application/zip" : ".zip,.json,application/zip,application/json"}
                  multiple={single}
                  disabled={!p.import.enabled || uploading !== null}
                  aria-describedby={`${ids}-file-help`}
                  onChange={(e) => setFiles([...(e.target.files ?? [])])}
                />
                <Button type="button" variant="outline" size="sm" disabled={!p.import.enabled || uploading !== null} onClick={() => fileRef.current?.click()}>
                  <FileUp aria-hidden />
                  Choose {single ? "file" : "a zip"}
                </Button>
                <span className="min-w-0 truncate font-mono text-xs text-muted-foreground">{files.length ? files.map((f) => f.name).join(", ") : "No file chosen"}</span>
              </div>
              <p id={`${ids}-file-help`} className="text-xs text-muted-foreground">
                {single ? "Add manifest.json from the same folder, so the app can check that the review was made from this journal. " : "Each folder holds its review.json and its manifest.json, as downloaded. "}
                Up to {p.maxUploadMb} MB.
              </p>
            </div>
          </div>
          <div>{importReason ? <DisabledReason reason={importReason}>{importButton}</DisabledReason> : importButton}</div>
          {uploading !== null ? (
            <div className="space-y-1" role="status">
              <Progress value={uploading} aria-label="Upload progress" />
              <p className="text-xs text-muted-foreground">Importing {plural(files.length, "file")}</p>
            </div>
          ) : null}
        </div>

        {problem && !fieldProblem ? (
          <Callout tone="destructive" title={problem.title} afterAction>
            {problem.body}
          </Callout>
        ) : null}
        {report ? <ImportResults report={report} /> : null}
      </div>
    </section>
  );
}

function ImportResults({ report }: { report: ImportReport }) {
  const { totals } = report;
  return (
    <div className="space-y-2" aria-live="polite">
      <p className="font-medium">
        {totals.imported ? `${plural(totals.imported, "review")} imported` : "No review was imported"}
        {totals.refused ? `, ${totals.refused} refused` : ""}
        {report.withoutReview ? `. ${plural(report.withoutReview, "folder")} had no review.json and ${report.withoutReview === 1 ? "was" : "were"} left alone` : ""}.
      </p>
      <ul className="divide-y rounded-lg border">
        {report.results.map((r, i) => {
          const t = resultText(r);
          const Icon = t.tone === "success" ? CircleCheck : t.tone === "warning" ? TriangleAlert : CircleX;
          return (
            <li key={i} className="flex items-start gap-2 px-3 py-2">
              <Icon className={`mt-0.5 size-4 shrink-0 ${t.tone === "success" ? "text-success-fg" : t.tone === "warning" ? "text-warning-fg" : "text-destructive-fg"}`} aria-hidden />
              <span className="min-w-0">
                <span className="block font-medium break-words">{t.title}</span>
                {t.body ? <span className="block text-xs break-words text-muted-foreground">{t.body}</span> : null}
                {r.status === "refused" && r.incidentId ? <span className="block font-mono text-xs break-all text-muted-foreground">{r.path}</span> : null}
              </span>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
