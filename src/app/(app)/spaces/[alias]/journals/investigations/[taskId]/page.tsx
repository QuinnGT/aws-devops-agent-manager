import { ChevronDown, ListChecks } from "lucide-react";
import Link from "next/link";
import { notFound } from "next/navigation";
import { z } from "zod";
import { SpaceTopBar } from "@/components/app-shell/space-top-bar";
import { EmptyState } from "@/components/common/empty-state";
import { PageHeader } from "@/components/common/page-header";
import { SectionCard } from "@/components/common/section-card";
import { StatusBadge } from "@/components/common/status-badge";
import { Time } from "@/components/common/time";
import { SafeMarkdown } from "@/components/safe-markdown";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import type { StoredExecution, StoredRecord } from "@/lib/journal/types";
import { cn } from "@/lib/utils";
import { globToRegExp } from "@/server/journals/import";
import { policyForSpace } from "@/server/journals/policy";
import { buildExecutionTree, getInvestigation, listRecords, type ExecutionNode } from "@/server/journals/queries";
import { renderRecordBody } from "@/server/journals/render";
import { templateSetFor, type TemplateSet } from "@/server/journals/templates/load";
import type { Policy } from "@/server/policy";
import { Detail, firstParams, ghostSm, hrefWith, loadSpaceForPage, NoAccess, outlineSm, Pager } from "../../_components/shared";
import { enumLabel, taskStatus } from "../../_components/words";

/**
 * One cached investigation: task details, the execution tree and paginated
 * records. Journal content is untrusted: markdown goes through SafeMarkdown,
 * everything else is shown as text in <pre>.
 */

const TASK_ID = /^[\w.:#/-]{1,256}$/;
const recordQuery = z.object({
  executionId: z.string().trim().max(256).optional().catch(undefined),
  recordType: z.string().trim().max(128).optional().catch(undefined),
  page: z.coerce.number().int().min(1).max(100_000).default(1).catch(1),
});

type UiPolicy = Policy["journals"]["ui"];

function clip(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, max)}\n\n(Shortened to ${max} characters for display. The export has the full record.)` : s;
}

function view(rec: StoredRecord, t: TemplateSet, ui: UiPolicy): { markdown: string | null; text: string | null } {
  const c = rec.content;
  if (c.kind === "markdown") return { markdown: c.text, text: null };
  if (c.kind === "text") {
    const md = ui.markdownTextRecordTypes.some((g) => globToRegExp(g).test(rec.recordType));
    return md ? { markdown: c.text, text: null } : { markdown: null, text: c.text };
  }
  if (ui.renderedRecordTypes.includes(rec.recordType)) {
    try {
      return { markdown: renderRecordBody(rec, t), text: null };
    } catch {
      /* fall back to the JSON */
    }
  }
  return { markdown: null, text: JSON.stringify(c.value, null, 2) ?? "" };
}

const PRE = "max-h-[32rem] overflow-auto rounded-md bg-muted p-3 font-mono text-xs whitespace-pre-wrap break-words";

function agentName(e: StoredExecution | undefined): string {
  if (!e) return "Execution";
  const agent = e.agentType ? enumLabel(e.agentType) : "Agent";
  return e.agentSubTask && e.agentSubTask !== e.agentType ? `${agent} / ${enumLabel(e.agentSubTask)}` : agent;
}

function RecordView({ rec, t, ui, execution }: { rec: StoredRecord; t: TemplateSet; ui: UiPolicy; execution: StoredExecution | undefined }) {
  const v = view(rec, t, ui);
  const raw = JSON.stringify(rec.raw, null, 2) ?? "";
  return (
    <article className="space-y-2 px-4 py-3" aria-labelledby={`rec-${rec.recordId}`}>
      <header className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
        <span id={`rec-${rec.recordId}`} className="font-mono font-semibold text-foreground tabular-nums">
          #{rec.seq}
        </span>
        <Badge variant="outline" className="h-[22px] font-mono font-medium text-muted-foreground">
          {rec.recordType}
        </Badge>
        <Time value={rec.createdAt} format="datetime" />
        <span aria-hidden>·</span>
        <span>
          {agentName(execution)} <span className="font-mono">{rec.executionId.slice(0, 8)}</span>
        </span>
      </header>
      {v.markdown !== null ? (
        <SafeMarkdown className="prose prose-sm max-w-[72ch] dark:prose-invert">{clip(v.markdown, ui.maxRawChars)}</SafeMarkdown>
      ) : (
        <pre className={PRE}>{clip(v.text ?? "", ui.maxRawChars)}</pre>
      )}
      {rec.raw !== null && rec.raw !== undefined ? (
        <details className="group">
          <summary className="inline-flex min-h-6 cursor-pointer items-center rounded-sm text-xs font-medium text-muted-foreground hover:text-foreground">
            <span className="group-open:hidden">Show raw record</span>
            <span className="hidden group-open:inline">Hide raw record</span>
          </summary>
          <pre className={cn(PRE, "mt-2")}>{clip(raw, ui.maxRawChars)}</pre>
        </details>
      ) : null}
    </article>
  );
}

function ExecutionTree({
  nodes,
  counts,
  hrefFor,
  active,
  depth = 0,
}: {
  nodes: ExecutionNode[];
  counts: Map<string, number>;
  hrefFor: (id: string) => string;
  active?: string;
  depth?: number;
}) {
  if (nodes.length === 0) return null;
  return (
    <ul className={cn("space-y-1", depth > 0 && "mt-1 ml-3 border-l pl-3")}>
      {nodes.map((n) => {
        const e = n.execution;
        const isActive = active === e.executionId;
        const records = counts.get(e.executionId) ?? 0;
        return (
          <li key={e.executionId}>
            <div className={cn("rounded-md px-2 py-1.5", isActive && "bg-muted")}>
              <div className="flex flex-wrap items-center gap-2">
                <Link
                  href={hrefFor(e.executionId)}
                  aria-current={isActive ? "true" : undefined}
                  className="inline-flex min-h-6 items-center rounded-sm text-[13px] font-semibold underline-offset-4 hover:underline"
                >
                  {agentName(e)}
                </Link>
                <StatusBadge {...taskStatus(e.status)} />
              </div>
              <div className="text-xs text-muted-foreground tabular-nums">
                {records} {records === 1 ? "record" : "records"}
                {e.createdAt ? (
                  <>
                    {" · started "}
                    <Time value={e.createdAt} format="datetime" />
                  </>
                ) : null}
              </div>
              <div className="font-mono text-xs break-all text-muted-foreground">{e.executionId}</div>
            </div>
            <ExecutionTree nodes={n.children} counts={counts} hrefFor={hrefFor} active={active} depth={depth + 1} />
          </li>
        );
      })}
    </ul>
  );
}

export default async function InvestigationPage(props: PageProps<"/spaces/[alias]/journals/investigations/[taskId]">) {
  const { alias, taskId: rawTaskId } = await props.params;
  const { user, space, perms, base } = await loadSpaceForPage(alias);
  if (!perms.read)
    return (
      <div className="mx-auto max-w-7xl space-y-4">
        <SpaceTopBar space={space} user={user} crumbs={[{ label: "Journals", href: base }, { label: "Investigation" }]} />
        <PageHeader title="Investigation" />
        <NoAccess />
      </div>
    );

  const taskId = decodeURIComponent(rawTaskId);
  if (!TASK_ID.test(taskId)) notFound();
  const inv = await getInvestigation(space.id, taskId);
  if (!inv) notFound();

  const q = recordQuery.parse(firstParams(await props.searchParams));
  const loaded = await policyForSpace(space);
  const ui = loaded.policy.journals.ui;
  const templates = templateSetFor(loaded);
  const { records, total } = await listRecords(space.id, taskId, { executionId: q.executionId, recordType: q.recordType, page: q.page, pageSize: ui.recordsPageSize });
  const self = `${base}/investigations/${encodeURIComponent(taskId)}`;
  const task = inv.task;
  const name = task.incidentId ?? task.taskId;
  const execById = new Map(inv.executions.map((e) => [e.executionId, e]));
  const allRecords = inv.typeCounts.reduce((n, t) => n + t.n, 0);
  const activeExec = q.executionId ? execById.get(q.executionId) : undefined;
  const analysisHref = `/spaces/${encodeURIComponent(space.alias)}/analysis/${encodeURIComponent(task.taskId)}`;
  const source =
    task.source === "import"
      ? `Imported from ${inv.importFile?.fileName ?? "an upload"}${task.importPath && task.importPath !== inv.importFile?.fileName ? ` (${task.importPath})` : ""}`
      : "Pulled from the API";

  return (
    <div className="mx-auto max-w-7xl space-y-4">
      <SpaceTopBar space={space} user={user} crumbs={[{ label: "Journals", href: base }, { label: name }]} />
      <PageHeader
        title={<span className={task.incidentId ? undefined : "font-mono text-lg"}>{name}</span>}
        badges={<StatusBadge {...taskStatus(task.status)} />}
        description={task.title ?? undefined}
        meta={[
          task.taskType ? enumLabel(task.taskType) : null,
          task.priority ? `${enumLabel(task.priority)} priority` : null,
          task.createdAt ? (
            <>
              Created <Time value={task.createdAt} format="datetime" />
            </>
          ) : null,
          task.source === "import" ? "Imported" : "Pulled from the API",
        ]}
        actions={
          perms.audits ? (
            <Link className={outlineSm} href={analysisHref}>
              <ListChecks aria-hidden />
              Open analysis
            </Link>
          ) : undefined
        }
      />

      <div className="grid items-start gap-4 xl:grid-cols-[minmax(0,1fr)_320px]">
        <SectionCard
          id="records"
          title="Records"
          aside={
            <span className="text-xs text-muted-foreground tabular-nums">
              {total} {total === 1 ? "record" : "records"}
              {q.executionId || q.recordType ? ` of ${allRecords}` : ""}, oldest first
            </span>
          }
        >
          <div role="toolbar" aria-label="Filter records" className="flex flex-wrap items-center gap-2 border-b px-4 py-2.5">
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="outline" size="sm">
                  {q.recordType ? (
                    <>
                      Type: <span className="font-mono">{q.recordType}</span>
                    </>
                  ) : (
                    "Type: All"
                  )}
                  <ChevronDown aria-hidden />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="start" className="min-w-56">
                <DropdownMenuItem asChild>
                  <Link href={hrefWith(self, { executionId: q.executionId })}>All record types</Link>
                </DropdownMenuItem>
                <DropdownMenuSeparator />
                {inv.typeCounts.map((t) => (
                  <DropdownMenuItem key={t.recordType} asChild>
                    <Link href={hrefWith(self, { executionId: q.executionId, recordType: t.recordType })} className="justify-between gap-4">
                      <span className="font-mono text-xs">{t.recordType}</span>
                      <span className="text-xs text-muted-foreground tabular-nums">{t.n}</span>
                    </Link>
                  </DropdownMenuItem>
                ))}
              </DropdownMenuContent>
            </DropdownMenu>
            {q.executionId ? (
              <span className="text-xs text-muted-foreground">
                In {agentName(activeExec)} <span className="font-mono">{q.executionId.slice(0, 8)}</span>
              </span>
            ) : null}
            {q.executionId || q.recordType ? (
              <Link className={ghostSm} href={self}>
                Show all records
              </Link>
            ) : null}
          </div>
          {records.length === 0 ? (
            <EmptyState title={allRecords === 0 ? "No records cached" : "No records match"}>
              {allRecords === 0
                ? "This investigation has no journal records in the cache. Export it again to fetch them."
                : "No records of this type in the selected execution. Show all records to see the others."}
            </EmptyState>
          ) : (
            <div className="divide-y">
              {records.map((r) => (
                <RecordView key={r.recordId} rec={r} t={templates} ui={ui} execution={execById.get(r.executionId)} />
              ))}
            </div>
          )}
          <Pager
            page={q.page}
            pageSize={ui.recordsPageSize}
            total={total}
            noun="records"
            hrefFor={(page) => hrefWith(self, { executionId: q.executionId, recordType: q.recordType, page })}
          />
        </SectionCard>

        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-1">
          <SectionCard id="details" title="Details">
            <dl className="py-2">
              <Detail label="Task ID">
                <span className="font-mono text-xs break-all">{task.taskId}</span>
              </Detail>
              {task.incidentId ? <Detail label="Incident ID">{task.incidentId}</Detail> : null}
              <Detail label="Title">{task.title ?? <span className="text-muted-foreground">Not set</span>}</Detail>
              <Detail label="Type">{task.taskType ? enumLabel(task.taskType) : <span className="text-muted-foreground">Not set</span>}</Detail>
              <Detail label="Priority">{task.priority ? enumLabel(task.priority) : <span className="text-muted-foreground">Not set</span>}</Detail>
              <Detail label="Created">{task.createdAt ? <Time value={task.createdAt} format="datetime" /> : <span className="text-muted-foreground">Not set</span>}</Detail>
              <Detail label="Source">{source}</Detail>
              {task.source !== "import" ? (
                <Detail label="Cached">
                  <Time value={task.fetchedAt} format="datetime" />
                </Detail>
              ) : null}
              {inv.importFile ? (
                <Detail label="Upload SHA-256">
                  <span className="font-mono text-xs break-all">{inv.importFile.sha256}</span>
                </Detail>
              ) : null}
            </dl>
            {task.reference ? (
              <details className="group border-t px-4 py-2">
                <summary className="inline-flex min-h-6 cursor-pointer items-center rounded-sm text-xs font-medium text-muted-foreground hover:text-foreground">
                  <span className="group-open:hidden">Show reference</span>
                  <span className="hidden group-open:inline">Hide reference</span>
                </summary>
                <pre className={cn(PRE, "mt-2")}>{JSON.stringify(task.reference, null, 2)}</pre>
              </details>
            ) : null}
          </SectionCard>

          <SectionCard
            id="executions"
            title="Executions"
            aside={<span className="text-xs text-muted-foreground tabular-nums">{inv.executions.length}</span>}
          >
            {inv.executions.length === 0 ? (
              <EmptyState title="No executions cached">Export this investigation again to fetch its executions and records.</EmptyState>
            ) : (
              <div className="px-2 py-2">
                <ExecutionTree
                  nodes={buildExecutionTree(inv.executions)}
                  counts={inv.recordCounts}
                  active={q.executionId}
                  hrefFor={(id) => hrefWith(self, { executionId: id, recordType: q.recordType })}
                />
              </div>
            )}
          </SectionCard>
        </div>
      </div>
    </div>
  );
}
