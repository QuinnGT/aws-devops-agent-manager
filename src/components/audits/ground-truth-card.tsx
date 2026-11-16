"use client";

import { Check, CircleX, FileUp, TriangleAlert, Upload } from "lucide-react";
import { useRouter } from "next/navigation";
import { useRef, useState } from "react";
import { Callout } from "@/components/common/callout";
import { DisabledReason } from "@/components/common/disabled-reason";
import { StatusBadge } from "@/components/common/status-badge";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import type { EvidenceMatchReport } from "@/server/audits/evidence";
import { cn } from "@/lib/utils";
import { fieldText, plural, unmatchedText } from "./words";

export interface EvidenceRowView {
  itemId: string;
  incidentId: string | null;
  taskId: string;
  inputs: {
    kind: string;
    label: string;
    required: boolean;
    doc: {
      fileName: string;
      uploadedBy: string;
      uploadedAt: string;
      uploadedAtText: string;
      fields: { key: string; label: string; value: string | null }[];
      /** Stored before this draft was created */
      reused: boolean;
      /** Reused, and uploaded to this draft again with the same bytes */
      uploadedAgain?: boolean;
    } | null;
  }[];
}

export interface GroundTruthInput {
  kind: string;
  label: string;
  required: boolean;
  /** An example file name the pattern takes, for the help text */
  example: string | null;
  hasFields: boolean;
}

/** Match reports of uploads made on New audit, for the draft page it moves to (client navigation keeps this module). */
const pending = new Map<string, EvidenceMatchReport>();
function takePending(auditId: string): EvidenceMatchReport | null {
  const r = pending.get(auditId) ?? null;
  pending.delete(auditId);
  return r;
}
const SHOWN = 5;

/**
 * The Ground truth card (pages/audit-new.md): a drop zone, counts, the
 * documents matched per incident (from the database, so they survive a
 * reload), and the last upload's not-matched files and replacements (kept in
 * the page while it is open). Shows names and extracted fields only, never a
 * document body. On New audit the first upload saves the draft (`ensureAudit`).
 */
export function GroundTruthCard({
  alias,
  auditId,
  ensureAudit,
  inputs,
  rows,
  maxUploadMb,
  disabledReason,
  names,
}: {
  alias: string;
  auditId: string | null;
  ensureAudit?: () => Promise<string | null>;
  inputs: GroundTruthInput[];
  rows: EvidenceRowView[];
  maxUploadMb: number;
  disabledReason: string | null;
  names: Record<string, string>;
}) {
  const router = useRouter();
  const fileRef = useRef<HTMLInputElement>(null);
  const [drag, setDrag] = useState(false);
  const [uploading, setUploading] = useState<{ files: number; pct: number } | null>(null);
  const [error, setError] = useState<{ title: string; body: string } | null>(null);
  // A report from an upload made on New audit, handed over when the page moved to the saved draft.
  const [report, setReport] = useState<EvidenceMatchReport | null>(() => (auditId ? takePending(auditId) : null));
  const [showAll, setShowAll] = useState(false);

  const required = inputs.filter((i) => i.required);
  const example = inputs.find((i) => i.example)?.example ?? null;
  const nameOf = (e: string) => names[e] ?? e;

  async function upload(files: File[]) {
    if (!files.length || disabledReason) return;
    setError(null);
    const id = auditId ?? (ensureAudit ? await ensureAudit() : null);
    if (!id) return;
    setUploading({ files: files.length, pct: 0 });
    const form = new FormData();
    for (const f of files) form.append("files", f, f.name);
    const xhr = new XMLHttpRequest();
    xhr.open("POST", `/api/spaces/${encodeURIComponent(alias)}/audits/${id}/ground-truth`);
    xhr.upload.onprogress = (e) => e.lengthComputable && setUploading({ files: files.length, pct: Math.round((e.loaded / e.total) * 100) });
    xhr.onerror = () => {
      setUploading(null);
      setError({ title: "The upload failed", body: "The connection to the app was lost. Try again." });
    };
    xhr.onload = () => {
      setUploading(null);
      let body: { report?: EvidenceMatchReport; error?: { title: string; body: string } } = {};
      try {
        body = JSON.parse(xhr.responseText) as typeof body;
      } catch {
        /* not JSON */
      }
      if (xhr.status === 200 && body.report) {
        if (!auditId) {
          pending.set(id, body.report);
          router.replace(`/spaces/${encodeURIComponent(alias)}/audits/${id}`);
          return;
        }
        setReport(body.report);
        router.refresh();
      } else setError(body.error ?? { title: "The upload failed", body: "Try again." });
    };
    xhr.send(form);
  }

  const incidentsInAudit = new Set(rows.map((r) => r.incidentId).filter(Boolean));
  const missing = rows.filter((r) => r.inputs.some((i) => i.required && !i.doc));
  const replaced = new Set((report?.matched ?? []).filter((m) => m.outcome === "replaced").map((m) => `${m.incidentId}\0${m.kind}`));
  // The same bytes as a document the space already holds: that copy is used. The last upload's report covers uploads made before the server recorded it.
  const unchanged = new Set((report?.matched ?? []).filter((m) => m.outcome === "unchanged").map((m) => `${m.incidentId}\0${m.kind}`));
  const sameFile = (r: EvidenceRowView, i: EvidenceRowView["inputs"][number]) => !!i.doc?.reused && (!!i.doc.uploadedAgain || unchanged.has(`${r.incidentId}\0${i.kind}`));
  const reusedDocs = rows.flatMap((r) => r.inputs.filter((i) => i.doc?.reused).map((i) => ({ doc: i.doc!, same: sameFile(r, i) })));
  const sameCount = reusedDocs.filter((d) => d.same).length;
  const alreadyCount = reusedDocs.length - sameCount;
  const notInAudit = (report?.matched ?? []).filter((m) => !incidentsInAudit.has(m.incidentId));
  const notMatched = [...(report?.unmatched ?? []).filter((u) => u.code !== "evidence.system-file"), ...notInAudit.map((m) => ({ fileName: m.fileName, reason: "", code: "evidence.incident-not-in-audit", incidentId: m.incidentId }))];
  const ordered = [...missing, ...rows.filter((r) => !missing.includes(r))];
  const shown = showAll ? ordered : ordered.slice(0, SHOWN);
  const fieldInputs = inputs.filter((i) => i.hasFields);

  const chooser = (
    <Button type="button" variant="outline" size="sm" onClick={() => fileRef.current?.click()} disabled={!!uploading}>
      <FileUp aria-hidden />
      Choose files
    </Button>
  );

  return (
    <section aria-labelledby="gt-h" className="rounded-xl border bg-card text-card-foreground">
      <div className="flex min-h-12 flex-wrap items-center justify-between gap-3 border-b px-4 py-2">
        <h2 id="gt-h" className="text-sm font-semibold">
          Ground truth
        </h2>
        {required.length ? <span className="text-xs text-muted-foreground">Per incident: {required.map((i) => i.label).join(", ")}</span> : null}
      </div>
      <div className="space-y-3 px-4 py-3">
        <div
          onDragOver={(e) => {
            if (disabledReason) return;
            e.preventDefault();
            setDrag(true);
          }}
          onDragLeave={() => setDrag(false)}
          onDrop={(e) => {
            e.preventDefault();
            setDrag(false);
            void upload([...e.dataTransfer.files]);
          }}
          className={cn("flex flex-wrap items-center gap-3 rounded-lg border-2 border-dashed px-4 py-3", drag ? "border-info bg-info/7" : "border-border bg-muted/30")}
        >
          <Upload className="size-4 shrink-0 text-muted-foreground" aria-hidden />
          <div className="min-w-0 flex-1 text-[13px]">
            <p className="font-semibold">Drop files or a zip here</p>
            <p className="text-muted-foreground">
              Up to {maxUploadMb} MB. File names are matched with the profile&apos;s patterns{example ? (
                <>
                  , for example <span className="font-mono text-xs">{example}</span>
                </>
              ) : null}
              .
            </p>
            {ensureAudit && !auditId ? (
              <p className="mt-1 text-muted-foreground">
                Uploading saves this audit as a draft and fixes its profile. You can still change the name, the models and the investigations.
              </p>
            ) : null}
            {uploading ? (
              <div className="mt-2 space-y-1" role="status">
                <Progress value={uploading.pct} aria-label="Upload progress" />
                <p className="text-xs text-muted-foreground">Uploading {plural(uploading.files, "file")}</p>
              </div>
            ) : null}
            {disabledReason ? (
              <DisabledReason reason={disabledReason} className="mt-2">
                {chooser}
              </DisabledReason>
            ) : null}
          </div>
          {disabledReason ? null : chooser}
          <input
            ref={fileRef}
            type="file"
            multiple
            accept=".md,.markdown,.txt,.zip,text/markdown,text/plain,application/zip"
            className="sr-only"
            tabIndex={-1}
            aria-hidden
            onChange={(e) => {
              const fs = [...(e.target.files ?? [])];
              e.target.value = "";
              void upload(fs);
            }}
          />
        </div>
        {error ? (
          <Callout
            tone="destructive"
            title={error.title}
            afterAction
            action={
              <Button type="button" variant="outline" size="sm" onClick={() => fileRef.current?.click()}>
                Try again
              </Button>
            }
          >
            {error.body}
          </Callout>
        ) : null}
      </div>

      {rows.length || report ? (
        <div className="flex flex-wrap items-baseline gap-x-6 gap-y-1 border-t px-4 py-3 text-[13px]">
          {report ? (
            <>
              <Count n={report.totals.files} label={report.totals.files === 1 ? "file uploaded" : "files uploaded"} />
              <Count n={report.totals.added + report.totals.replaced + report.totals.unchanged} label="matched" />
              <Count n={notMatched.length} label="not matched" warn />
            </>
          ) : null}
          {sameCount ? <Count n={sameCount} label={sameCount === 1 ? "same as an earlier upload, which is used" : "same as earlier uploads, which are used"} warn={false} /> : null}
          {alreadyCount ? <Count n={alreadyCount} label="already in this space" warn={false} /> : null}
          {rows.length ? <Count n={missing.length} label={missing.length === 1 ? "incident still missing a document" : "incidents still missing a document"} warn /> : null}
        </div>
      ) : null}

      {rows.length ? (
        <div className="overflow-x-auto border-t">
          <table className="w-full text-[13px]">
            <thead className="bg-muted/50 text-left text-muted-foreground">
              <tr>
                <th className="px-4 py-2 font-medium">Incident</th>
                {inputs.map((i) => (
                  <th key={i.kind} className="px-2 py-2 font-medium">
                    {i.label}
                  </th>
                ))}
                {fieldInputs.map((i) => (
                  <th key={`f-${i.kind}`} className="px-2 py-2 pr-4 font-medium">
                    Read from the {i.label.toLowerCase().replace(/^benchmark /, "")}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y">
              {shown.map((r) => (
                <tr key={r.itemId} className="align-top">
                  <td className="px-4 py-2 font-mono text-xs whitespace-nowrap">{r.incidentId ?? r.taskId}</td>
                  {r.inputs.map((i) => (
                    <td key={i.kind} className="px-2 py-2">
                      {i.doc ? (
                        <>
                          <p className="flex items-center gap-1 text-success-fg">
                            <Check className="size-3.5 shrink-0" aria-hidden />
                            {sameFile(r, i) ? "Matched" : i.doc.reused ? "Already in this space" : replaced.has(`${r.incidentId}\0${i.kind}`) ? "Replaces an older upload" : "Matched"}
                          </p>
                          <p className="text-xs text-muted-foreground">
                            {sameFile(r, i) ? (
                              `Same file as the one uploaded ${i.doc.uploadedAtText}; that copy is used`
                            ) : i.doc.reused ? (
                              `Uploaded ${i.doc.uploadedAtText} by ${nameOf(i.doc.uploadedBy)}`
                            ) : (
                              <span className="font-mono">{i.doc.fileName}</span>
                            )}
                          </p>
                        </>
                      ) : i.required ? (
                        <StatusBadge tone="destructive" icon={CircleX} label="Missing" />
                      ) : (
                        <span className="text-muted-foreground">None</span>
                      )}
                    </td>
                  ))}
                  {fieldInputs.map((fi) => {
                    const doc = r.inputs.find((i) => i.kind === fi.kind)?.doc;
                    if (!doc) return <td key={`f-${fi.kind}`} className="px-2 py-2 pr-4 text-muted-foreground">Nothing to read</td>;
                    const found = doc.fields.filter((f) => f.value !== null);
                    const notFound = doc.fields.filter((f) => f.value === null);
                    return (
                      <td key={`f-${fi.kind}`} className="px-2 py-2 pr-4">
                        {found.length ? <p>{found.map((f) => fieldText(f.label, f.value!)).join(" · ")}</p> : null}
                        {notFound.map((f) => (
                          <p key={f.key} className="text-xs text-warning-fg">
                            {f.label} not found
                          </p>
                        ))}
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
          {ordered.length > SHOWN ? (
            <div className="flex justify-center border-t px-4 py-2">
              <Button type="button" variant="ghost" size="sm" onClick={() => setShowAll((s) => !s)}>
                {showAll ? "Show fewer incidents" : `Show ${plural(ordered.length - SHOWN, "more incident")}`}
              </Button>
            </div>
          ) : null}
        </div>
      ) : null}

      {notMatched.length ? (
        <div className="border-t">
          <div className="flex items-center justify-between px-4 py-2.5">
            <h3 className="text-sm font-semibold">Not matched</h3>
            <span className="text-xs text-muted-foreground">{plural(notMatched.length, "file")}</span>
          </div>
          <ul className="divide-y border-t text-[13px]">
            {notMatched.map((u, i) => (
              <li key={`${u.fileName}-${i}`} className="flex items-start gap-2 px-4 py-2">
                <TriangleAlert className="mt-0.5 size-4 shrink-0 text-warning-fg" aria-hidden />
                <span>
                  {"incidentId" in u ? `${u.fileName}: incident ${u.incidentId} isn't in this audit.` : unmatchedText(u, example)}
                  {u.code ? <span className="block font-mono text-xs text-muted-foreground">{u.code}</span> : null}
                </span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {missing.length ? (
        <div className="border-t">
          <div className="flex items-center justify-between px-4 py-2.5">
            <h3 className="text-sm font-semibold">Still missing</h3>
            <span className="text-xs text-muted-foreground">{plural(missing.length, "incident")}</span>
          </div>
          <ul className="divide-y border-t text-[13px]">
            {missing.slice(0, 20).map((r) => (
              <li key={r.itemId} className="flex items-start gap-2 px-4 py-2">
                <CircleX className="mt-0.5 size-4 shrink-0 text-destructive-fg" aria-hidden />
                <span>
                  {r.incidentId ?? r.taskId} has no{" "}
                  {r.inputs
                    .filter((i) => i.required && !i.doc)
                    .map((i) => i.label)
                    .join(" and ")}
                  . The review needs it, so this investigation is skipped unless you upload one.
                </span>
              </li>
            ))}
          </ul>
          {missing.length > 20 ? <p className="border-t px-4 py-2 text-[13px] text-muted-foreground">And {plural(missing.length - 20, "more incident")}.</p> : null}
        </div>
      ) : null}
    </section>
  );
}

function Count({ n, label, warn = false }: { n: number; label: string; warn?: boolean }) {
  return (
    <span>
      <span className={cn("mr-1.5 text-lg font-semibold tabular-nums", warn && n > 0 && "text-warning-fg")}>{n}</span>
      {label}
    </span>
  );
}
