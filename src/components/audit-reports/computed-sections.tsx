import Link from "next/link";
import type { ReactNode } from "react";
import { EmptyState } from "@/components/common/empty-state";
import { buttonVariants } from "@/components/ui/button";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import type { CountTableContent, FindingsTableContent, IncidentListContent, MetricsTableContent } from "@/server/audit-reports";
import { ExpandableTable } from "./expandable-table";
import { countHeader, pluralLabel, shareText, shownCountRows, type KindLabel } from "./words";

/**
 * Bodies of the computed sections (pages/audit-report.md, "Body by kind"),
 * built on the server from the report view. Every value is plain text: model
 * output and finding values never render as markup.
 */

const num = "text-right tabular-nums";
const head = "h-9 bg-muted/50 px-4 text-xs font-medium text-muted-foreground";
const cell = "px-4 py-2 whitespace-normal align-top";

/** "Nothing accepted yet", with a link to the audit's findings when the person can review them. */
export function NothingAccepted({ findingsHref }: { findingsHref: string }) {
  return (
    <EmptyState
      title="Nothing accepted yet"
      action={
        <Link href={findingsHref} className={buttonVariants({ variant: "outline", size: "sm" })}>
          Open findings
        </Link>
      }
    >
      This table counts accepted findings only. Accept findings to see them here.
    </EmptyState>
  );
}

export function CountTableBody({ c, kind, findingsHref }: { c: CountTableContent; kind: KindLabel | undefined; findingsHref: string }) {
  const rows = shownCountRows(c.rows);
  if (c.total === 0 || rows.length === 0) return <NothingAccepted findingsHref={findingsHref} />;
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead className={head}>{c.header}</TableHead>
          <TableHead className={`${head} ${num}`}>{countHeader(kind)}</TableHead>
          <TableHead className={`${head} ${num}`}>Share</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {rows.map((r) => (
          <TableRow key={r.value ?? "\0none"}>
            <TableCell className={cell}>{r.label}</TableCell>
            <TableCell className={`${cell} ${num}`}>{r.count}</TableCell>
            <TableCell className={`${cell} ${num}`}>{shareText(r.count, c.total)}</TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

export function FindingsTableBody({ c, kind, title, findingsHref }: { c: FindingsTableContent; kind: KindLabel | undefined; title: string; findingsHref: string }) {
  if (!c.rows.length) return <NothingAccepted findingsHref={findingsHref} />;
  const plural = kind ? pluralLabel(kind.label) : "rows";
  return (
    <ExpandableTable
      label={title}
      moreLabel={`Show all ${c.rows.length} ${plural}`}
      head={
        <TableHeader>
          <TableRow>
            {c.columns.map((col) => (
              <TableHead key={col.id} className={head}>
                {col.header}
              </TableHead>
            ))}
            <TableHead className={head}>Incident</TableHead>
          </TableRow>
        </TableHeader>
      }
      rows={c.rows.map((r) => (
        <TableRow key={r.findingId}>
          {r.cells.map((v, i) => (
            <TableCell key={c.columns[i]?.id ?? i} className={`${cell} ${i === 0 && c.columns.length > 1 ? "w-52" : ""} max-w-[60ch] break-words`}>
              {v}
            </TableCell>
          ))}
          <TableCell className={`${cell} font-mono text-xs whitespace-nowrap`}>{r.incident}</TableCell>
        </TableRow>
      ))}
    />
  );
}

export function MetricsTableBody({ c, title }: { c: MetricsTableContent; title: string }) {
  if (!c.rows.length) return <EmptyState title="No investigations to measure">The audit has no reviewed investigations yet.</EmptyState>;
  return (
    <ExpandableTable
      label={title}
      moreLabel={`Show all ${c.rows.length} incidents`}
      head={
        <TableHeader>
          <TableRow>
            <TableHead className={head}>Incident</TableHead>
            {c.columns.map((col) => (
              <TableHead key={col.id} className={`${head} ${num}`}>
                {col.header}
              </TableHead>
            ))}
          </TableRow>
        </TableHeader>
      }
      rows={c.rows.map((r) => (
        <TableRow key={r.taskId}>
          <TableCell className={`${cell} font-mono text-xs`}>{r.incident}</TableCell>
          {r.cells.map((v, i) => (
            <TableCell key={c.columns[i]?.id ?? i} className={`${cell} ${num} ${v === null ? "text-muted-foreground" : ""}`}>
              {v ?? (r.missing ? "No output" : "")}
            </TableCell>
          ))}
        </TableRow>
      ))}
      foot={
        c.rows.length > 1 ? (
          <TableRow className="border-t font-semibold">
            <TableCell className={cell}>Median of {c.rows.length}</TableCell>
            {c.medians.map((m, i) => (
              <TableCell key={c.columns[i]?.id ?? i} className={`${cell} ${num}`}>
                {m ?? ""}
              </TableCell>
            ))}
          </TableRow>
        ) : null
      }
    />
  );
}

export function IncidentListBody({ c, findingsHref }: { c: IncidentListContent; findingsHref: string }) {
  if (!c.incidents.length) return <NothingAccepted findingsHref={findingsHref} />;
  return (
    <ul className="divide-y">
      {c.incidents.map((b) => (
        <li key={b.findingId} className="space-y-1.5 px-4 py-3 text-[13px]">
          <p className="font-mono text-xs text-muted-foreground">{b.incident}</p>
          <p className="max-w-[72ch] font-semibold break-words">{b.title}</p>
          <dl className="grid max-w-[90ch] grid-cols-[minmax(8rem,auto)_1fr] gap-x-4 gap-y-1">
            {[...b.evidence, ...b.fields].map((f): ReactNode => (
              <div key={f.id} className="contents">
                <dt className="text-muted-foreground">{f.label}</dt>
                <dd className="break-words">{f.value}</dd>
              </div>
            ))}
          </dl>
        </li>
      ))}
    </ul>
  );
}
