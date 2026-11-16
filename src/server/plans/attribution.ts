import { and, eq, isNotNull } from "drizzle-orm";
import { db } from "@/server/db/client";
import { planItems, plans } from "@/server/db/schema";
import { parseClientToken } from "./client-token";

/**
 * Attribution lookup (AttributionDeps.findPlanItemByClientToken): a
 * CloudTrail write event whose clientToken is one of this app's plan item
 * tokens was made by the app. The sync passes it to attributeChanges.
 * Only items the apply actually started writing count.
 */
export async function findPlanItemByClientToken(clientToken: string): Promise<{ planId: string; appUser: string } | null> {
  const parsed = parseClientToken(clientToken);
  if (!parsed) return null;
  const [row] = await db()
    .select({ planId: plans.id, appUser: plans.applyStartedBy, createdBy: plans.createdBy })
    .from(planItems)
    .innerJoin(plans, eq(planItems.planId, plans.id))
    .where(and(eq(planItems.id, parsed.planItemId), isNotNull(planItems.writeStartedAt)));
  if (!row) return null;
  return { planId: row.planId, appUser: row.appUser ?? row.createdBy };
}
