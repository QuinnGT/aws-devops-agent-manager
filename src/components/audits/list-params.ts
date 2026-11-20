import type { AuditStateFilter } from "@/server/audits/ui";

/**
 * URL state of the audit pages (pages/audits.md and audit-detail.md,
 * "Filters"). Defaults are left out of the URL. Pure; unit-tested.
 */

type Raw = Record<string, string | string[] | undefined>;
const first = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);
const text = (v: string | string[] | undefined, max = 200) => (first(v) ?? "").trim().slice(0, max);

export const AUDIT_PAGE = 50;
const MAX_SHOW = 500;

function show(v: string | string[] | undefined): number {
  const n = Number.parseInt(first(v) ?? "", 10);
  return Number.isFinite(n) && n > AUDIT_PAGE ? Math.min(Math.ceil(n / AUDIT_PAGE) * AUDIT_PAGE, MAX_SHOW) : AUDIT_PAGE;
}

function query(entries: [string, string | number | null | undefined, string | number][]): string {
  const q = new URLSearchParams();
  for (const [k, v, def] of entries) if (v !== null && v !== undefined && v !== "" && v !== def) q.set(k, String(v));
  const s = q.toString();
  return s ? `?${s}` : "";
}

// ---------------------------------------------------------------- audits list

export const AUDIT_STATE_OPTIONS: { value: AuditStateFilter; label: string; hint: string }[] = [
  { value: "open", label: "Open", hint: "Draft, running, in review" },
  { value: "finalized", label: "Record saved", hint: "" },
  { value: "cancelled", label: "Cancelled", hint: "" },
  { value: "all", label: "All", hint: "" },
];

export interface AuditListParams {
  state: AuditStateFilter;
  profile: string;
  q: string;
  show: number;
}

export function parseAuditListParams(sp: Raw): AuditListParams {
  const state = first(sp.state);
  return {
    state: AUDIT_STATE_OPTIONS.some((o) => o.value === state) ? (state as AuditStateFilter) : "open",
    profile: text(sp.profile, 100),
    q: text(sp.q),
    show: show(sp.show),
  };
}

export function auditListQuery(p: Partial<AuditListParams>): string {
  return query([
    ["state", p.state, "open"],
    ["profile", p.profile, ""],
    ["q", p.q, ""],
    ["show", p.show, AUDIT_PAGE],
  ]);
}

// ---------------------------------------------------------------- Investigations tab

export type ItemShow = "all" | "proposed" | "citations" | "failed";
export const ITEM_SHOWS: ItemShow[] = ["all", "proposed", "citations", "failed"];

export interface ItemListParams {
  show: ItemShow;
  q: string;
  rows: number;
}

export function parseItemListParams(sp: Raw): ItemListParams {
  const s = first(sp.show);
  return { show: ITEM_SHOWS.includes(s as ItemShow) ? (s as ItemShow) : "all", q: text(sp.q), rows: show(sp.rows) };
}

export function itemListQuery(p: Partial<ItemListParams>): string {
  return query([
    ["show", p.show, "all"],
    ["q", p.q, ""],
    ["rows", p.rows, AUDIT_PAGE],
  ]);
}

// ---------------------------------------------------------------- Findings tab

/** The Findings tab's "Next step" filter: every finding, the package fixes, or the accepted ones not in a revision yet. */
export const FIX_FILTERS = ["", "package", "open"] as const;
export type FixFilter = (typeof FIX_FILTERS)[number];

export interface FindingListParams {
  kind: string;
  /** "" means the default for the audit's state */
  state: "" | "proposed" | "accepted" | "rejected" | "all";
  mode: string;
  owner: string;
  fix: FixFilter;
  q: string;
  rows: number;
  /** The selected finding's ID (a revision links here); "" selects the first in the list */
  finding: string;
}

const FINDING_STATES = ["proposed", "accepted", "rejected", "all"] as const;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function parseFindingListParams(sp: Raw): FindingListParams {
  const s = first(sp.state);
  const fix = first(sp.fix) ?? "";
  const finding = text(sp.finding, 40);
  return {
    kind: text(sp.kind, 100),
    state: (FINDING_STATES as readonly string[]).includes(s ?? "") ? (s as FindingListParams["state"]) : "",
    mode: text(sp.mode, 100),
    owner: text(sp.owner, 100),
    fix: (FIX_FILTERS as readonly string[]).includes(fix) ? (fix as FixFilter) : "",
    q: text(sp.q),
    rows: show(sp.rows),
    finding: UUID.test(finding) ? finding : "",
  };
}

export function findingListQuery(p: Partial<FindingListParams>): string {
  return query([
    ["kind", p.kind, ""],
    ["state", p.state, ""],
    ["mode", p.mode, ""],
    ["owner", p.owner, ""],
    ["fix", p.fix, ""],
    ["q", p.q, ""],
    ["rows", p.rows, AUDIT_PAGE],
    ["finding", p.finding, ""],
  ]);
}

/** The Findings tab's default state: Proposed while findings can be reviewed, All otherwise. */
export function defaultFindingState(auditState: string): "proposed" | "all" {
  return auditState === "running" || auditState === "reviewing" ? "proposed" : "all";
}

/** Query string from the values, leaving out defaults and empty values. Pure. */
export function filterQuery(values: Record<string, string>, defaults: Record<string, string>): string {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(values)) if (v && v !== (defaults[k] ?? "")) q.set(k, v);
  const s = q.toString();
  return s ? `?${s}` : "";
}

