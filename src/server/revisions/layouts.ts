import { and, desc, eq, inArray, isNotNull } from "drizzle-orm";
import { db } from "@/server/db/client";
import { packageImports, releases, revisions } from "@/server/db/schema";
import type { Policy } from "@/server/policy";

/**
 * The layout a new revision starts with: the space's usual one, which is the
 * layout its last package import or its last release used (a release made
 * from a revision's plan used that revision's layout), whichever is newer;
 * else the policy's defaultLayout. Reads Postgres only.
 */

export type UsualLayoutSource = "import" | "release" | "default";

export interface UsualLayout {
  name: string;
  source: UsualLayoutSource;
  /** When that import or release was made */
  at: Date | null;
  /** The release's name, for a release source */
  release?: string | null;
}

export interface LayoutCandidate {
  layout: string;
  at: Date;
  release?: string | null;
}

/** The newer of the last import's and the last release's layout, when the policy still has it; else the default. Pure. */
export function chooseUsualLayout(policy: Pick<Policy, "packageLayouts">, lastImport: LayoutCandidate | null, lastRelease: LayoutCandidate | null): UsualLayout {
  const known = (c: LayoutCandidate | null) => (c && policy.packageLayouts.layouts[c.layout] ? c : null);
  const imp = known(lastImport);
  const rel = known(lastRelease);
  const pick = imp && rel ? (rel.at.getTime() > imp.at.getTime() ? "release" : "import") : imp ? "import" : rel ? "release" : null;
  if (pick === "import") return { name: imp!.layout, source: "import", at: imp!.at };
  if (pick === "release") return { name: rel!.layout, source: "release", at: rel!.at, release: rel!.release ?? null };
  const fallback = policy.packageLayouts.defaultLayout ?? Object.keys(policy.packageLayouts.layouts)[0] ?? "";
  return { name: fallback, source: "default", at: null };
}

export async function usualLayout(spaceId: string, policy: Pick<Policy, "packageLayouts">): Promise<UsualLayout> {
  const [imp] = await db()
    .select({ layout: packageImports.layout, at: packageImports.createdAt })
    .from(packageImports)
    .where(and(eq(packageImports.spaceId, spaceId), inArray(packageImports.status, ["analyzed", "planning", "planned"])))
    .orderBy(desc(packageImports.createdAt))
    .limit(1);
  const [rel] = await db()
    .select({ layout: revisions.layout, at: releases.createdAt, release: releases.name })
    .from(releases)
    .innerJoin(revisions, and(eq(revisions.releaseId, releases.id), eq(revisions.spaceId, releases.spaceId)))
    .where(and(eq(releases.spaceId, spaceId), isNotNull(revisions.releaseId)))
    .orderBy(desc(releases.createdAt))
    .limit(1);
  return chooseUsualLayout(policy, imp ?? null, rel ?? null);
}
