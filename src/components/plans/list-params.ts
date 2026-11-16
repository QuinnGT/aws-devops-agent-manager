import type { PlanRow } from "@/server/plans/types";
import { PLAN_STATUS_FILTERS, type PlanStatusFilter } from "@/server/plans/view";

/**
 * URL state of the plans list (pages/plans.md, "Filters"): `status`
 * (open, closed, all), `origin` (all or one PlanOrigin kind), `q` (title) and
 * `show` (rows shown, in steps of PAGE). Defaults are left out of the URL.
 * Pure; unit-tested.
 */

export type OriginFilter = "all" | PlanRow["originKind"];

export interface PlanListParams {
  status: PlanStatusFilter;
  origin: OriginFilter;
  q: string;
  show: number;
}

export const PLAN_PAGE = 50;
const MAX_SHOW = 500;

export const STATUS_OPTIONS: { value: PlanStatusFilter; label: string }[] = [
  { value: "open", label: "Open" },
  { value: "closed", label: "Closed" },
  { value: "all", label: "All" },
];

export const ORIGIN_OPTIONS: { value: OriginFilter; label: string }[] = [
  { value: "all", label: "All" },
  { value: "drafts", label: "Drafts" },
  { value: "rollback", label: "Restore" },
  { value: "package", label: "Package import" },
  { value: "retry", label: "Retry of a failed plan" },
];

type Raw = Record<string, string | string[] | undefined>;
const first = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);

export function parsePlanListParams(sp: Raw): PlanListParams {
  const status = first(sp.status);
  const origin = first(sp.origin);
  const show = Number.parseInt(first(sp.show) ?? "", 10);
  return {
    status: status && status in PLAN_STATUS_FILTERS ? (status as PlanStatusFilter) : "open",
    origin: ORIGIN_OPTIONS.some((o) => o.value === origin) ? (origin as OriginFilter) : "all",
    q: (first(sp.q) ?? "").trim().slice(0, 200),
    show: Number.isFinite(show) && show > PLAN_PAGE ? Math.min(Math.ceil(show / PLAN_PAGE) * PLAN_PAGE, MAX_SHOW) : PLAN_PAGE,
  };
}

/** Query string for these params, without defaults ("" or "?status=all&q=verity"). */
export function planListQuery(p: Partial<PlanListParams>): string {
  const q = new URLSearchParams();
  if (p.status && p.status !== "open") q.set("status", p.status);
  if (p.origin && p.origin !== "all") q.set("origin", p.origin);
  if (p.q) q.set("q", p.q);
  if (p.show && p.show > PLAN_PAGE) q.set("show", String(p.show));
  const s = q.toString();
  return s ? `?${s}` : "";
}

export function hasFilters(p: PlanListParams): boolean {
  return p.origin !== "all" || p.q !== "";
}
