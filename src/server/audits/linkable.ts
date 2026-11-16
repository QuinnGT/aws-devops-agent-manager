import { and, desc, eq, ilike, inArray, sql } from "drizzle-orm";
import { db } from "@/server/db/client";
import { auditItems, audits, findings } from "@/server/db/schema";
import { auditProfileSchema } from "@/server/policy/sections/audits";
import type { LinkableFinding } from "./contract";

/**
 * Accepted findings a revision may link to: state "accepted" and an extractor
 * marked `linkable` in the profile the audit ran with. Optional filters were
 * added without changing the signature.
 *
 * A finding stays linkable after its item is reviewed again (its decision is
 * kept with the earlier review), so a revision's existing links resolve by
 * `ids`. Without `ids`, only findings of each item's current review are listed
 * unless `includeSuperseded` is set, so a picker does not offer stale ones.
 */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function listLinkableFindings(
  spaceId: string,
  opts: {
    ids?: string[];
    auditId?: string;
    limit?: number;
    /** Only findings of this extractor kind */
    kind?: string;
    incidentId?: string;
    /** Case-insensitive part of the title */
    q?: string;
    /** Include findings of earlier reviews (default: only with `ids`) */
    includeSuperseded?: boolean;
  } = {},
): Promise<LinkableFinding[]> {
  const includeSuperseded = opts.includeSuperseded ?? !!opts.ids;
  const ids = opts.ids?.filter((id) => UUID_RE.test(id));
  const q = opts.q?.trim();
  const rows = await db()
    .select({ f: findings, auditName: audits.name, profile: audits.profileSnapshot })
    .from(findings)
    .innerJoin(audits, eq(audits.id, findings.auditId))
    .innerJoin(auditItems, eq(auditItems.id, findings.auditItemId))
    .where(
      and(
        eq(findings.spaceId, spaceId),
        eq(findings.state, "accepted"),
        ids ? inArray(findings.id, ids.length ? ids : ["00000000-0000-0000-0000-000000000000"]) : undefined,
        opts.auditId ? eq(findings.auditId, opts.auditId) : undefined,
        opts.kind ? eq(findings.kind, opts.kind) : undefined,
        opts.incidentId ? eq(findings.incidentId, opts.incidentId) : undefined,
        q ? ilike(findings.title, `%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`) : undefined,
        includeSuperseded ? undefined : sql`${findings.reviewId} = ${auditItems.currentReviewId}`,
      ),
    )
    .orderBy(desc(findings.reviewedAt))
    .limit(Math.min(opts.limit ?? 500, 2000));

  return rows
    .filter((r) => {
      const profile = auditProfileSchema.safeParse(r.profile);
      return profile.success && profile.data.findings.some((x) => x.kind === r.f.kind && x.linkable);
    })
    .map((r) => ({
      id: r.f.id,
      auditId: r.f.auditId,
      auditName: r.auditName,
      incidentId: r.f.incidentId,
      kind: r.f.kind,
      title: r.f.title,
      values: r.f.current,
      reviewedBy: r.f.reviewedBy,
      reviewedAt: r.f.reviewedAt?.toISOString() ?? null,
    }));
}
