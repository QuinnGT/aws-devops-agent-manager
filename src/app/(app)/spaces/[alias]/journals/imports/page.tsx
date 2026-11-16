import Link from "next/link";
import { EmptyState } from "@/components/common/empty-state";
import { LiveJobProgress } from "@/components/common/live-job-progress";
import { SectionCard } from "@/components/common/section-card";
import { StatusBadge } from "@/components/common/status-badge";
import { Time } from "@/components/common/time";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import type { ImportReport } from "@/server/journals/import";
import { policyForSpace } from "@/server/journals/policy";
import { listImports } from "@/server/journals/queries";
import { ImportForm } from "../_components/import-form";
import { JournalsHeader, loadSpaceForPage, NoAccess, TD, TH } from "../_components/shared";
import { enumLabel, fmtBytes, importOutcome, importSummary, jobStatus } from "../_components/words";

/** The per-file list of one import report, collapsed by default. File paths come from the upload: plain text only. */
function ReportFiles({ report, base }: { report: ImportReport; base: string }) {
  if (!report.files.length) return null;
  return (
    <details className="group mt-1.5">
      <summary className="inline-flex min-h-6 cursor-pointer items-center rounded-sm text-xs font-medium text-muted-foreground hover:text-foreground">
        <span className="group-open:hidden">Show {report.files.length === 1 ? "1 file" : `${report.files.length} files`}</span>
        <span className="hidden group-open:inline">Hide files</span>
      </summary>
      <ul className="mt-2 space-y-2">
        {report.files.map((f) => (
          <li key={f.path} className="space-y-0.5">
            <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
              <StatusBadge {...importOutcome(f.outcome)} />
              <span className="font-mono text-xs break-all">{f.path}</span>
            </div>
            {f.taskId && (f.outcome === "imported" || f.outcome === "already-cached") ? (
              <div className="text-xs text-muted-foreground">
                <Link className="underline underline-offset-2 hover:text-foreground" href={`${base}/investigations/${encodeURIComponent(f.taskId)}`}>
                  {f.incidentId ?? f.taskId}
                </Link>
                {`, ${f.records ?? 0} ${f.records === 1 ? "record" : "records"}`}
              </div>
            ) : null}
            {f.note ? <div className="text-xs text-muted-foreground">{f.note}</div> : null}
            {f.error ? <div className="text-xs text-destructive-fg">{f.error}</div> : null}
            {f.warnings?.length ? (
              <ul className="ml-4 list-disc text-xs text-muted-foreground">
                {f.warnings.map((w, i) => (
                  <li key={i}>{w}</li>
                ))}
              </ul>
            ) : null}
          </li>
        ))}
      </ul>
    </details>
  );
}

/** Import form and the space's imports, each with its parse report. */
export default async function ImportsPage(props: PageProps<"/spaces/[alias]/journals/imports">) {
  const { alias } = await props.params;
  const { user, space, perms, base } = await loadSpaceForPage(alias);
  const header = <JournalsHeader space={space} user={user} base={base} active="imports" perms={perms} />;
  if (!perms.read)
    return (
      <div className="mx-auto max-w-7xl space-y-4">
        {header}
        <NoAccess />
      </div>
    );

  const limits = (await policyForSpace(space)).policy.journals.import;
  const imports = await listImports(space.id);

  return (
    <div className="mx-auto max-w-7xl space-y-4">
      {header}
      {perms.import ? (
        <div className="grid items-start gap-4 xl:grid-cols-[minmax(0,1fr)_320px]">
          <SectionCard id="import-upload" title="Import journals">
            <ImportForm alias={space.alias} maxMb={Math.floor(limits.maxUploadBytes / 1048576)} />
          </SectionCard>
          <SectionCard id="import-rules" title="What the import does">
            <ol className="list-decimal space-y-1.5 py-3 pr-4 pl-9 text-[13px]">
              <li>A zip exported by this app is imported from its raw JSON.</li>
              <li>In other zips, files named like a full journal are imported.</li>
              <li>RCA and scorecard files are listed in the report without being imported.</li>
              <li>An upload that was imported before is skipped.</li>
            </ol>
          </SectionCard>
        </div>
      ) : null}

      <SectionCard
        id="imports"
        title={imports.length === 1 ? "1 import" : `${imports.length} imports`}
        aside={<span className="text-xs text-muted-foreground">{imports.length >= 50 ? "The latest 50, newest first" : "Newest first"}</span>}
      >
        {imports.length === 0 ? (
          <EmptyState title="No imports yet">
            {perms.import
              ? "Upload a markdown journal or a zip above. Each upload appears here with its report."
              : "Uploaded journal files appear here with their reports. Importing needs the journals.import permission."}
          </EmptyState>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className={TH}>File</TableHead>
                <TableHead className={TH}>Status</TableHead>
                <TableHead className={TH}>Report</TableHead>
                <TableHead className={`${TH} text-right`}>Uploaded</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {imports.map((i) => {
                const active = i.status === "queued" || i.status === "running";
                const report = i.parseReport as ImportReport | null;
                return (
                  <TableRow key={i.id}>
                    <TableCell className={`${TD} max-w-sm`}>
                      <div className="font-semibold break-all">{i.fileName}</div>
                      <div className="text-xs text-muted-foreground">
                        {enumLabel(i.format)} · {fmtBytes(i.sizeBytes)}
                      </div>
                      <div className="font-mono text-xs break-all text-muted-foreground">SHA-256 {i.sha256}</div>
                    </TableCell>
                    <TableCell className={`${TD} min-w-48`}>
                      <StatusBadge {...jobStatus(i.status)} />
                      {active && i.jobRunId ? (
                        <div className="mt-2 max-w-64">
                          <LiveJobProgress runId={i.jobRunId} />
                        </div>
                      ) : null}
                    </TableCell>
                    <TableCell className={`${TD} max-w-xl`}>
                      {report ? (
                        <>
                          <p>{importSummary(report.totals)}</p>
                          {report.error ? <p className="text-xs text-destructive-fg">{report.error}</p> : null}
                          {report.duplicateOf ? <p className="text-xs text-muted-foreground">This file was imported before, so it was skipped.</p> : null}
                          <ReportFiles report={report} base={base} />
                        </>
                      ) : (
                        <span className="text-xs text-muted-foreground">{active ? "The report appears when the import finishes." : "No report"}</span>
                      )}
                    </TableCell>
                    <TableCell className={`${TD} text-right whitespace-nowrap`}>
                      <Time value={i.createdAt} format="datetime" />
                      <div className="text-xs text-muted-foreground">{i.importedBy}</div>
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        )}
      </SectionCard>
    </div>
  );
}
