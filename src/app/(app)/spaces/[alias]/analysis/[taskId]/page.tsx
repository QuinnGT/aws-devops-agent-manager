import { NotebookText } from "lucide-react";
import Link from "next/link";
import { notFound } from "next/navigation";
import { SpaceTopBar } from "@/components/app-shell/space-top-bar";
import { EmptyState } from "@/components/common/empty-state";
import { PageHeader } from "@/components/common/page-header";
import { SectionCard } from "@/components/common/section-card";
import { Time } from "@/components/common/time";
import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import type { CondensedTraceOutput } from "@/server/analyzers/condensed-trace";
import type { DeployedVsReadOutput } from "@/server/analyzers/deployed-vs-read";
import type { MemoryReadsOutput } from "@/server/analyzers/memory-reads";
import type { OutputRulesOutput } from "@/server/analyzers/output-rules";
import { ANALYZERS } from "@/server/analyzers/registry";
import type { RunMetricsOutput } from "@/server/analyzers/run-metrics";
import { getInvestigationTask, latestRunsForTask, type AnalyzerRunRow } from "@/server/analyzers/store";
import { can, requireUserOrRedirect } from "@/server/auth/dal";
import { getSpaceByAlias } from "@/server/spaces/queries";
import { outlineSm } from "../../journals/_components/shared";
import { analyzerOptions } from "../options";
import { RunForInvestigation } from "../run-analyzers";
import { CondensedTraceView, DeployedVsReadView, MemoryReadsView, OutputRulesView, RawOutputView, RunMetricsView } from "../views";

function AnalyzerOutput({ row }: { row: AnalyzerRunRow }) {
  const current = ANALYZERS.find((a) => a.id === row.analyzer);
  // Output from an older analyzer version may have another shape; show it raw.
  if (!current || current.version !== row.analyzerVersion) return <RawOutputView output={row.output} />;
  switch (row.analyzer) {
    case "run-metrics":
      return <RunMetricsView o={row.output as RunMetricsOutput} />;
    case "memory-reads":
      return <MemoryReadsView o={row.output as MemoryReadsOutput} />;
    case "condensed-trace":
      return <CondensedTraceView o={row.output as CondensedTraceOutput} />;
    case "output-rules":
      return <OutputRulesView o={row.output as OutputRulesOutput} />;
    case "deployed-vs-read":
      return <DeployedVsReadView o={row.output as DeployedVsReadOutput} />;
    default:
      return <RawOutputView output={row.output} />;
  }
}

export default async function InvestigationAnalysisPage({ params }: PageProps<"/spaces/[alias]/analysis/[taskId]">) {
  const user = await requireUserOrRedirect();
  const { alias, taskId } = await params;
  const space = await getSpaceByAlias(alias);
  if (!space || !(await can(user, "audits.read", space.id))) notFound();
  const task = await getInvestigationTask(space.id, taskId);
  if (!task) notFound();
  const [runs, canRun, canReadJournals] = await Promise.all([latestRunsForTask(space.id, task.taskId), can(user, "audits.run", space.id), can(user, "journals.read", space.id)]);
  const byAnalyzer = new Map(runs.map((r) => [r.analyzer, r]));
  const base = `/spaces/${encodeURIComponent(space.alias)}/analysis`;
  const first = ANALYZERS.find((a) => byAnalyzer.has(a.id)) ?? ANALYZERS[0]!;
  const name = task.incidentId ?? task.taskId;

  return (
    <div className="mx-auto max-w-7xl space-y-4">
      <SpaceTopBar space={space} user={user} crumbs={[{ label: "Analysis", href: base }, { label: name }]} />
      <PageHeader
        title={<span className={task.incidentId ? undefined : "font-mono text-lg"}>{name}</span>}
        badges={
          <Badge variant="outline" className="h-[22px] font-medium text-muted-foreground">
            {task.source === "import" ? "Imported" : "Pulled"}
          </Badge>
        }
        description={task.title ?? undefined}
        meta={[
          `${task.records} ${task.records === 1 ? "record" : "records"}`,
          task.incidentId ? <span className="font-mono text-xs">{task.taskId}</span> : null,
          `${runs.length} of ${ANALYZERS.length} analyzers run`,
        ]}
        actions={
          canReadJournals ? (
            <Link className={outlineSm} href={`/spaces/${encodeURIComponent(space.alias)}/journals/investigations/${encodeURIComponent(task.taskId)}`}>
              <NotebookText aria-hidden />
              Open journal
            </Link>
          ) : undefined
        }
      />

      {canRun ? (
        <SectionCard id="run" title="Run analyzers" aside={<span className="text-xs text-muted-foreground">Unchanged results are skipped</span>}>
          <RunForInvestigation alias={space.alias} taskId={task.taskId} options={analyzerOptions()} />
        </SectionCard>
      ) : null}

      <Card className="gap-0 py-0">
        <Tabs defaultValue={first.id} className="gap-0">
          <div className="overflow-x-auto border-b px-2 pt-1">
            <TabsList variant="line" aria-label="Analyzers">
              {ANALYZERS.map((a) => (
                <TabsTrigger key={a.id} value={a.id}>
                  {a.label}
                  {byAnalyzer.has(a.id) ? null : <span className="text-xs font-normal text-muted-foreground">(not run)</span>}
                </TabsTrigger>
              ))}
            </TabsList>
          </div>
          {ANALYZERS.map((a) => {
            const row = byAnalyzer.get(a.id);
            return (
              <TabsContent key={a.id} value={a.id} className="space-y-4 rounded-b-xl px-4 py-4 focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring">
                <div className="space-y-1">
                  <h2 className="text-sm font-semibold">{a.label}</h2>
                  <p className="max-w-[72ch] text-[13px] text-muted-foreground">{a.description}.</p>
                  {row ? (
                    <p className="text-xs text-muted-foreground tabular-nums">
                      Version {row.analyzerVersion}, run <Time value={row.createdAt} format="datetime" />
                      {row.recordCount !== null ? `, ${row.recordCount} records` : ""}
                      {row.durationMs !== null ? `, ${row.durationMs} ms` : ""}. Input digest <span className="font-mono">{row.inputDigest.slice(0, 12)}</span>.
                      {row.analyzerVersion !== a.version ? ` The current version is ${a.version}; run the analyzer again to update this result.` : ""}
                    </p>
                  ) : null}
                </div>
                {row ? (
                  <AnalyzerOutput row={row} />
                ) : (
                  <EmptyState title="Not run yet" className="px-0">
                    {a.requires.includes("package")
                      ? "This analyzer compares the journal with an instruction package, which this page can't supply yet."
                      : canRun
                        ? "Run it with the Run analyzers panel above."
                        : "Running analyzers needs the audits.run permission."}
                  </EmptyState>
                )}
              </TabsContent>
            );
          })}
        </Tabs>
      </Card>
    </div>
  );
}
