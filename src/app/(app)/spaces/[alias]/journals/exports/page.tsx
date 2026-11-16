import { Download } from "lucide-react";
import { EmptyState } from "@/components/common/empty-state";
import { LiveJobProgress } from "@/components/common/live-job-progress";
import { SectionCard } from "@/components/common/section-card";
import { StatusBadge } from "@/components/common/status-badge";
import { Time } from "@/components/common/time";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { policyForSpace } from "@/server/journals/policy";
import { listExportJobs } from "@/server/journals/queries";
import { describeSelection, exportSelectionSchema } from "@/server/journals/selection";
import { ExportForm } from "../_components/export-form";
import { JournalsHeader, loadSpaceForPage, NoAccess, outlineSm, TD, TD_NUM, TH, TH_NUM } from "../_components/shared";
import { exportFileState, fmtBytes, jobStatus } from "../_components/words";

interface ExportSummary {
  notFoundTaskIds?: string[];
  unmatchedIncidentIds?: string[];
  fetchedExecutions?: number;
  cachedExecutions?: number;
}

/** Export form and the space's export jobs, with progress and download links. */
export default async function ExportsPage(props: PageProps<"/spaces/[alias]/journals/exports">) {
  const { alias } = await props.params;
  const { user, space, perms, base } = await loadSpaceForPage(alias);
  const header = <JournalsHeader space={space} user={user} base={base} active="exports" perms={perms} />;
  if (!perms.read)
    return (
      <div className="mx-auto max-w-7xl space-y-4">
        {header}
        <NoAccess />
      </div>
    );

  const pol = (await policyForSpace(space)).policy.journals;
  const jobs = await listExportJobs(space.id);
  const now = new Date();
  const apiBase = `/api/spaces/${encodeURIComponent(space.alias)}/journals/exports`;

  return (
    <div className="mx-auto max-w-7xl space-y-4">
      {header}
      {perms.export ? (
        <SectionCard id="new-export" title="New export" aside={<span className="text-xs text-muted-foreground">Zip files are deleted {pol.exportRetentionDays} days after they are created</span>}>
          <p className="max-w-[72ch] px-4 pt-3 text-[13px] text-muted-foreground">
            The export reads investigations, executions and journal records from the space with its read role, caches them here, and builds one zip with the raw
            JSON, markdown and a manifest.
          </p>
          <ExportForm
            alias={space.alias}
            taskTypes={pol.selection.taskTypes}
            statuses={pol.selection.statuses}
            priorities={pol.selection.priorities}
            maxIds={pol.selection.maxIds}
            hasIncidentRule={space.parsedSettings.incidentIdRule !== null}
          />
        </SectionCard>
      ) : null}

      <SectionCard
        id="exports"
        title={jobs.length === 1 ? "1 export" : `${jobs.length} exports`}
        aside={<span className="text-xs text-muted-foreground">{jobs.length >= 50 ? "The latest 50, newest first" : "Newest first"}</span>}
      >
        {jobs.length === 0 ? (
          <EmptyState title="No exports yet">
            {perms.export
              ? "Start an export above. Each export appears here with its progress, and its zip can be downloaded when it finishes."
              : "Exports appear here with their progress and zip file. Starting one needs the journals.export permission."}
          </EmptyState>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className={`${TH} hidden lg:table-cell`}>Requested</TableHead>
                <TableHead className={TH}>Selection</TableHead>
                <TableHead className={TH}>Status</TableHead>
                <TableHead className={`${TH_NUM} hidden xl:table-cell`}>Investigations</TableHead>
                <TableHead className={`${TH_NUM} hidden xl:table-cell`}>Records</TableHead>
                <TableHead className={TH}>File</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {jobs.map((j) => {
                const sel = exportSelectionSchema.safeParse(j.selection);
                const summary = (j.summary ?? {}) as ExportSummary;
                const active = j.status === "queued" || j.status === "running";
                const file = exportFileState(j, now);
                return (
                  <TableRow key={j.id}>
                    <TableCell className={`${TD} hidden whitespace-nowrap lg:table-cell`}>
                      <Time value={j.createdAt} format="datetime" />
                      <div className="text-xs text-muted-foreground">{j.createdBy}</div>
                    </TableCell>
                    <TableCell className={`${TD} max-w-sm`}>
                      <div className="text-xs text-muted-foreground lg:hidden">
                        <Time value={j.createdAt} format="datetime" /> · {j.createdBy}
                      </div>
                      {sel.success ? describeSelection(sel.data) : "Unreadable selection"}
                      {summary.notFoundTaskIds?.length ? (
                        <div className="text-xs text-destructive-fg">Task IDs not found: {summary.notFoundTaskIds.join(", ")}</div>
                      ) : null}
                      {summary.unmatchedIncidentIds?.length ? (
                        <div className="text-xs text-destructive-fg">Incident IDs with no task: {summary.unmatchedIncidentIds.join(", ")}</div>
                      ) : null}
                      {j.taskCount !== null ? (
                        <div className="text-xs text-muted-foreground tabular-nums xl:hidden">
                          {j.taskCount} {j.taskCount === 1 ? "investigation" : "investigations"}, {j.recordCount ?? 0} {j.recordCount === 1 ? "record" : "records"}
                        </div>
                      ) : null}
                      {summary.fetchedExecutions !== undefined ? (
                        <div className="text-xs text-muted-foreground">
                          {summary.fetchedExecutions} {summary.fetchedExecutions === 1 ? "execution" : "executions"} fetched, {summary.cachedExecutions ?? 0} reused from the cache
                        </div>
                      ) : null}
                    </TableCell>
                    <TableCell className={`${TD} lg:min-w-52`}>
                      <StatusBadge {...jobStatus(j.status)} />
                      {active && j.jobRunId ? (
                        <div className="mt-2 max-w-64">
                          <LiveJobProgress runId={j.jobRunId} />
                        </div>
                      ) : null}
                      {j.error ? <div className="mt-1 max-w-80 text-xs break-words text-destructive-fg">{j.error}</div> : null}
                    </TableCell>
                    <TableCell className={`${TD_NUM} hidden xl:table-cell`}>{j.taskCount ?? ""}</TableCell>
                    <TableCell className={`${TD_NUM} hidden xl:table-cell`}>{j.recordCount ?? ""}</TableCell>
                    <TableCell className={`${TD} max-w-xs`}>
                      {file === "download" ? (
                        <div className="space-y-1">
                          {perms.export ? (
                            <a className={outlineSm} href={`${apiBase}/${j.id}/download`} download>
                              <Download aria-hidden />
                              Download zip
                            </a>
                          ) : null}
                          <div className="font-mono text-xs break-all">{j.fileName}</div>
                          <div className="text-xs text-muted-foreground">
                            {fmtBytes(j.sizeBytes)}
                            {j.expiresAt ? (
                              <>
                                {" · deleted "}
                                <Time value={j.expiresAt} format="date" />
                              </>
                            ) : null}
                          </div>
                          <div className="font-mono text-xs break-all text-muted-foreground">SHA-256 {j.sha256}</div>
                        </div>
                      ) : file === "deleted" || file === "expired" ? (
                        <div className="text-xs text-muted-foreground">
                          <span className="font-mono break-all">{j.fileName}</span>
                          <div>{file === "deleted" ? "Deleted after the retention period" : "Expired, waiting for deletion"}</div>
                        </div>
                      ) : (
                        <span className="text-xs text-muted-foreground">{active ? "Built when the export finishes" : "No file"}</span>
                      )}
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
