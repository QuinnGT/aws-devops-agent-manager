import { downloadReviewFiles, uploadReviews } from "@/server/audits/review-files-http";

/**
 * The review files of one investigation of a hand-off audit: GET downloads its
 * folder as a zip, POST imports its review.json (and the manifest.json beside
 * it). A review for another investigation is refused.
 */
export async function GET(_req: Request, ctx: RouteContext<"/api/spaces/[alias]/audits/[auditId]/items/[itemId]/review-files">) {
  const { alias, auditId, itemId } = await ctx.params;
  return downloadReviewFiles({ alias, auditId, itemId });
}

export async function POST(req: Request, ctx: RouteContext<"/api/spaces/[alias]/audits/[auditId]/items/[itemId]/review-files">) {
  const { alias, auditId, itemId } = await ctx.params;
  return uploadReviews(req, { alias, auditId, itemId });
}
