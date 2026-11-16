import { CircleX, TriangleAlert } from "lucide-react";
import type { ReactNode } from "react";
import { StatusBadge } from "@/components/common/status-badge";
import { Time } from "@/components/common/time";
import { SafeMarkdown } from "@/components/safe-markdown";
import { Badge } from "@/components/ui/badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import type { CondensedTraceOutput } from "@/server/analyzers/condensed-trace";
import type { DeployedVsReadOutput } from "@/server/analyzers/deployed-vs-read";
import type { MemoryReadsOutput } from "@/server/analyzers/memory-reads";
import type { OutputRulesOutput } from "@/server/analyzers/output-rules";
import type { RunMetricsOutput } from "@/server/analyzers/run-metrics";

/**
 * Read-only views of stored analyzer output. Journal text is untrusted:
 * markdown goes through SafeMarkdown, everything else renders as plain text.
 */

const TH = "h-auto bg-muted px-3 py-2 text-xs font-medium text-muted-foreground";
const TD = "px-3 py-2 align-top text-[13px] whitespace-normal";
const PROSE = "prose prose-sm max-w-[72ch] dark:prose-invert";

function Frame({ children }: { children: ReactNode }) {
  return <div className="overflow-hidden rounded-lg border">{children}</div>;
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="space-y-2">
      <h3 className="text-sm font-semibold">{title}</h3>
      {children}
    </section>
  );
}

function None({ children }: { children: ReactNode }) {
  return <p className="text-[13px] text-muted-foreground">{children}</p>;
}

/** An ISO time (or "YYYY-MM-DD HH:MM:SS" in UTC) as a Time, else the text as it is. */
function When({ value }: { value: string | null }) {
  if (!value) return null;
  const iso = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}/.test(value) ? `${value.replace(" ", "T")}Z` : value;
  return Number.isNaN(new Date(iso).getTime()) ? <>{value}</> : <Time value={iso} format="datetime" />;
}

function KeyValues({ rows }: { rows: [string, ReactNode][] }) {
  return (
    <Frame>
      <Table>
        <TableBody>
          {rows.map(([k, v]) => (
            <TableRow key={k}>
              <TableCell className={`${TD} w-72 text-muted-foreground`}>{k}</TableCell>
              <TableCell className={`${TD} tabular-nums`}>{v === null || v === undefined || v === "" ? <span className="text-muted-foreground">None</span> : v}</TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </Frame>
  );
}

function Counts({ title, counts, empty }: { title: string; counts: Record<string, number>; empty: string }) {
  const entries = Object.entries(counts);
  return (
    <Section title={title}>
      {entries.length === 0 ? (
        <None>{empty}</None>
      ) : (
        <Frame>
          <Table>
            <TableBody>
              {entries.map(([k, n]) => (
                <TableRow key={k}>
                  <TableCell className={`${TD} font-mono text-xs break-all`}>{k}</TableCell>
                  <TableCell className={`${TD} w-24 text-right tabular-nums`}>{n}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </Frame>
      )}
    </Section>
  );
}

function List({ title, items, empty }: { title: string; items: string[]; empty: string }) {
  return <Section title={title}>{items.length === 0 ? <None>{empty}</None> : <p className="font-mono text-xs leading-6 break-words">{items.join(", ")}</p>}</Section>;
}

function Plain({ text }: { text: string }) {
  return <pre className="max-h-96 overflow-auto rounded-md bg-muted p-3 font-mono text-xs whitespace-pre-wrap break-words">{text}</pre>;
}

export function RunMetricsView({ o }: { o: RunMetricsOutput }) {
  const s = o.summary;
  return (
    <div className="space-y-6">
      <KeyValues
        rows={[
          ["Execution", <span key="e" className="font-mono text-xs break-all">{o.execution}</span>],
          ["Records (parsed / in header)", `${o.records_parsed}${o.records_header === null ? "" : ` / ${o.records_header}`}`],
          ["Start", <When key="s" value={o.start_utc} />],
          ["End", <When key="e" value={o.end_utc} />],
          ["Span (min)", o.span_min],
          ["First investigation summary (min)", o.first_summary_min],
          ["Last assistant message to summary (min)", o.finalize_min],
          ["Investigation summaries", o.n_inv_summaries],
          ["Mitigation summaries", o.n_mit_summaries],
          ["Assistant messages with text", o.assistant_msgs],
          ["Prompt length (characters)", o.prompt_chars],
          ["Max context used (%)", o.max_ctx_pct],
          ["Max compactions", o.max_compactions],
          ["Lead agent tool calls", o.tool_calls_lead],
        ]}
      />
      <Section title="Time split">
        <KeyValues
          rows={[
            ["Duration (min)", s.dur_min],
            ["Model turns (min)", s.model_min],
            ["Waiting on tools (min)", s.tool_min],
            ["Waiting on subagents (min)", s.subwait_min],
            ["Rounds with tool calls", s.rounds],
            ["Calls per round", s.calls_per_round],
            ["Thinking (characters)", s.thinking_chars],
            ["Memory reads (fs_read)", s.mem_reads],
            ["Tool searches", s.tool_search],
            ["Tool results with status error", s.tool_errors],
            ["First hypothesis (min)", s.first_hyp_min],
            ["First cause (min)", s.first_cause_min],
            ["Root cause (min)", s.root_min],
            ["Messages with known tool calls / text only", `${s.structured_messages} / ${s.unstructured_messages}`],
          ]}
        />
        {s.unstructured_messages > 0 ? (
          <p className="max-w-[72ch] text-[13px] text-muted-foreground">
            Some imported messages carry text only, so the time split and tool call counts from messages are incomplete for them. Lead agent tool calls come from
            utilization records.
          </p>
        ) : null}
      </Section>
      <div className="grid gap-6 lg:grid-cols-2">
        <Counts title="Lead agent tool calls by name (utilization)" counts={o.tools} empty="No utilization records." />
        <Counts title="Tool calls by name (messages)" counts={s.tool_calls_by_name} empty="No tool calls in the messages." />
        <Counts title="Error signals in tool results" counts={o.err_signal_msgs} empty="No tool results." />
        <Counts title="Record types" counts={o.types} empty="No records." />
      </div>
      <List title="Subagents" items={o.subagents} empty="No subagents." />
      <List title="Skills loaded" items={o.skills} empty="No skills." />
      <Section title="Confidence section of the final summary">
        {o.confidence_section ? <SafeMarkdown className={PROSE}>{o.confidence_section}</SafeMarkdown> : <None>No Confidence section.</None>}
      </Section>
      <Section title="CMDB section of the prompt">{o.cmdb_section ? <SafeMarkdown className={PROSE}>{o.cmdb_section}</SafeMarkdown> : <None>No CMDB section.</None>}</Section>
      <Section title="Authorization error examples">
        {o.auth_err_examples.length === 0 ? (
          <None>None.</None>
        ) : (
          <Frame>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className={`${TH} w-20 text-right`}>Record</TableHead>
                  <TableHead className={TH}>Start of the tool result</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {o.auth_err_examples.map((e, i) => (
                  <TableRow key={i}>
                    <TableCell className={`${TD} text-right tabular-nums`}>{e.rec}</TableCell>
                    <TableCell className={`${TD} font-mono text-xs break-words`}>{e.snip}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </Frame>
        )}
      </Section>
    </div>
  );
}

function PathTable({ title, rows, empty }: { title: string; rows: [number, string][]; empty: string }) {
  return (
    <Section title={title}>
      {rows.length === 0 ? (
        <None>{empty}</None>
      ) : (
        <Frame>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className={`${TH} w-20 text-right`}>Record</TableHead>
                <TableHead className={TH}>Path</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map(([n, p], i) => (
                <TableRow key={i}>
                  <TableCell className={`${TD} text-right tabular-nums`}>{n}</TableCell>
                  <TableCell className={`${TD} font-mono text-xs break-all`}>{p}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </Frame>
      )}
    </Section>
  );
}

export function MemoryReadsView({ o }: { o: MemoryReadsOutput }) {
  const kinds = Object.entries(o.indexes_read);
  return (
    <div className="space-y-6">
      <KeyValues
        rows={[
          ["Failure-pattern memory listed in an index", o.failpat_listed_in_index ? "Yes" : "No"],
          ["Records where its content came back", o.failpat_content_records.join(", ")],
          ["Memory paths requested", o.memory_file_paths.length],
          ["Files not found", o.file_not_found.length],
        ]}
      />
      <Section title="Index listings read">
        {kinds.length === 0 ? (
          <None>No index listings in this journal.</None>
        ) : (
          <Frame>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className={TH}>Kind</TableHead>
                  <TableHead className={TH}>Read at record (entries)</TableHead>
                  <TableHead className={TH}>Entries in the last listing</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {kinds.map(([k, reads]) => (
                  <TableRow key={k}>
                    <TableCell className={`${TD} font-mono text-xs`}>{k}</TableCell>
                    <TableCell className={`${TD} tabular-nums`}>{reads.map((r) => `${r.rec} (${r.n})`).join(", ")}</TableCell>
                    <TableCell className={`${TD} font-mono text-xs break-words`}>{(o.index_entries[k] ?? []).join(", ")}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </Frame>
        )}
      </Section>
      <PathTable title="Memory paths requested" rows={o.memory_file_paths} empty="No memory paths were requested in the parts of the journal that keep tool inputs." />
      <PathTable title="Files not found" rows={o.file_not_found} empty="None." />
    </div>
  );
}

export function CondensedTraceView({ o }: { o: CondensedTraceOutput }) {
  return (
    <div className="space-y-4">
      <p className="max-w-[72ch] text-[13px] text-muted-foreground">
        {o.entries.length} entries from {o.records} records. Utilization records and early progress summaries are left out; long text is cut.
      </p>
      <ol className="space-y-4">
        {o.entries.map((e) => (
          <li key={`${e.n}-${e.label}`} className="space-y-1 border-l-2 pl-3">
            <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
              <span className="font-mono font-semibold text-foreground">R{e.n}</span>
              <Badge variant="outline" className="h-[22px] font-medium text-muted-foreground">
                {e.label}
              </Badge>
              <When value={e.time} />
              {e.truncatedChars > 0 ? <span>{e.truncatedChars} characters cut</span> : null}
            </div>
            {e.kind === "summary" || e.kind === "assistant" || e.kind === "agent-record" || e.kind === "prompt" ? (
              <SafeMarkdown className={PROSE}>{e.text}</SafeMarkdown>
            ) : (
              <Plain text={e.text} />
            )}
          </li>
        ))}
      </ol>
    </div>
  );
}

export function OutputRulesView({ o }: { o: OutputRulesOutput }) {
  return (
    <div className="space-y-6">
      <KeyValues
        rows={[
          ["Records checked", o.checkedRecords],
          ["Errors", o.errors],
          ["Warnings", o.warnings],
        ]}
      />
      <Counts title="Matches by rule" counts={o.counts} empty="No rule matched." />
      {o.violations.length > 0 ? (
        <Section title="Matches">
          <Frame>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className={`${TH} w-20 text-right`}>Record</TableHead>
                  <TableHead className={TH}>Record type</TableHead>
                  <TableHead className={TH}>Rule</TableHead>
                  <TableHead className={TH}>Severity</TableHead>
                  <TableHead className={TH}>Context</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {o.violations.map((v, i) => (
                  <TableRow key={i}>
                    <TableCell className={`${TD} text-right tabular-nums`}>{v.n}</TableCell>
                    <TableCell className={`${TD} font-mono text-xs`}>{v.recordType}</TableCell>
                    <TableCell className={TD}>
                      <div className="font-mono text-xs">{v.ruleId}</div>
                      {v.description ? <div className="text-xs text-muted-foreground">{v.description}</div> : null}
                    </TableCell>
                    <TableCell className={TD}>
                      {v.severity === "error" ? (
                        <StatusBadge tone="destructive" icon={CircleX} label="Error" />
                      ) : (
                        <StatusBadge tone="warning" icon={TriangleAlert} label="Warning" />
                      )}
                    </TableCell>
                    <TableCell className={`${TD} font-mono text-xs break-words`}>{v.excerpt}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </Frame>
        </Section>
      ) : null}
    </div>
  );
}

const VERDICT_LABELS: Record<string, string> = {
  matches: "Matches the package",
  near: "Nearly matches: some lines differ",
  different: "Different version from the package",
  "requested-no-body": "Requested, no returned body in the journal",
  "not-read": "Not read in this journal",
};

export function DeployedVsReadView({ o }: { o: DeployedVsReadOutput }) {
  const pct = (x: number | null) => (x === null ? "" : `${Math.round(x * 100)}%`);
  return (
    <div className="space-y-6">
      <Counts title="Files by verdict" counts={o.counts} empty="No package files." />
      <List title="Stores referenced in the journal" items={o.stores.filter((s) => s.referenced).map((s) => s.store)} empty="None of the package's stores." />
      <Frame>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className={TH}>Deployed path</TableHead>
              <TableHead className={TH}>Requested</TableHead>
              <TableHead className={`${TH} text-right`}>Package lines found</TableHead>
              <TableHead className={`${TH} text-right`}>Returned lines in package</TableHead>
              <TableHead className={TH}>Verdict</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {o.files.map((f) => (
              <TableRow key={f.deployedPath}>
                <TableCell className={`${TD} font-mono text-xs break-all`}>{f.deployedPath}</TableCell>
                <TableCell className={TD}>{f.read ? `Yes (record ${f.readAt.join(", ")})` : "No"}</TableCell>
                <TableCell className={`${TD} text-right tabular-nums`}>{pct(f.pkg)}</TableCell>
                <TableCell className={`${TD} text-right tabular-nums`}>{pct(f.ret)}</TableCell>
                <TableCell className={TD}>
                  {VERDICT_LABELS[f.verdict] ?? f.verdict}
                  {f.packageOnly.length || f.deployedOnly.length ? (
                    <div className="mt-1 space-y-0.5 font-mono text-xs text-muted-foreground">
                      {f.packageOnly.map((l, i) => (
                        <div key={`p${i}`}>Package only: {l}</div>
                      ))}
                      {f.deployedOnly.map((l, i) => (
                        <div key={`d${i}`}>Deployed only: {l}</div>
                      ))}
                    </div>
                  ) : null}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </Frame>
    </div>
  );
}

export function RawOutputView({ output }: { output: unknown }) {
  return <Plain text={JSON.stringify(output, null, 2)} />;
}
