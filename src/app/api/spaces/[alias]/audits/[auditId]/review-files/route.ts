import { downloadReviewFiles, uploadReviews } from "@/server/audits/review-files-http";

/**
 * The review files of a hand-off audit: GET downloads a zip with a folder for
 * each investigation, POST imports reviews (a zip of the folders, or one
 * review.json). Permissions, limits and the audit log are in review-files-http.ts.
 */
export async function GET(_req: Request, ctx: RouteContext<"/api/spaces/[alias]/audits/[auditId]/review-files">) {
  const { alias, auditId } = await ctx.params;
  return downloadReviewFiles({ alias, auditId });
}

export async function POST(req: Request, ctx: RouteContext<"/api/spaces/[alias]/audits/[auditId]/review-files">) {
  const { alias, auditId } = await ctx.params;
  return uploadReviews(req, { alias, auditId });
}
