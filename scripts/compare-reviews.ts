// Compares an audit's model reviews with reference reviews and prints the result.
// Read-only: it reads the database and the reference folder and makes no model or AWS calls.
//
// Usage:
//   pnpm exec tsx --env-file-if-exists=.env --tsconfig tsconfig.json scripts/compare-reviews.ts <audit-id> [--reference-dir <dir>] [--json]
//
// The reference folder holds one <incident>.json per incident. Default: the
// reference reviews of the sample benchmark set, sample-data/audit/reviews
// (AnyCompany Tickets, INCIDENT-20101 to INCIDENT-20108). For another set,
// pass --reference-dir or set DAM_REFERENCE_REVIEWS_DIR.
import { fileURLToPath } from "node:url";
import { closeDatabase } from "@/server/db/client";
import { compareAudit } from "@/server/review/compare-audit";
import { formatComparisons, totalComparisons } from "@/server/review/compare";

function usage(message?: string): never {
  if (message) console.error(message);
  console.error("Usage: scripts/compare-reviews.ts <audit-id> [--reference-dir <dir>] [--json]");
  process.exit(2);
}

async function main() {
  const args = process.argv.slice(2);
  let auditId: string | undefined;
  let referenceDir: string | undefined;
  let json = false;
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a === "--json") json = true;
    else if (a === "--reference-dir") referenceDir = args[++i];
    else if (a.startsWith("--")) usage(`Unknown option ${a}`);
    else auditId = a;
  }
  if (!auditId || !/^[0-9a-f-]{36}$/i.test(auditId)) usage("Give the audit ID (a UUID).");
  referenceDir ??= process.env.DAM_REFERENCE_REVIEWS_DIR || fileURLToPath(new URL("../sample-data/audit/reviews", import.meta.url));

  try {
    const result = await compareAudit(auditId, referenceDir);
    if (json) {
      console.log(JSON.stringify({ ...result, totals: totalComparisons(result.comparisons) }, null, 2));
      return;
    }
    console.log(`Audit ${result.auditName} (${result.auditId}) compared with ${referenceDir}\n`);
    console.log(formatComparisons(result.comparisons));
    if (result.missingReference.length) console.log(`\nNo reference review for: ${result.missingReference.join(", ")}`);
    if (result.notReviewed.length) console.log(`No current review for: ${result.notReviewed.join(", ")}`);
  } finally {
    await closeDatabase();
  }
}

main().catch((e: unknown) => {
  console.error(e instanceof Error ? e.message : String(e));
  process.exit(1);
});
