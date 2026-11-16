import type { JobDefinition } from "@/server/jobs/registry";
import { jobs as analyzerJobs } from "@/server/analyzers/jobs";
import { jobs as assetJobs } from "@/server/assets/jobs";
import { jobs as auditJobs } from "@/server/audits/jobs";
import { jobs as auditReportJobs } from "@/server/audit-reports/jobs";
import { jobs as journalJobs } from "@/server/journals/jobs";
import { jobs as planJobs } from "@/server/plans/jobs";
import { jobs as releaseJobs } from "@/server/releases/jobs";
import { jobs as revisionJobs } from "@/server/revisions/jobs";
import { jobs as packageIoJobs } from "@/server/package-io/jobs";
import { jobs as spaceJobs } from "@/server/spaces/jobs";
import { jobs as syncJobs } from "@/server/sync/jobs";
import { jobs as verifyJobs } from "@/server/verify/jobs";

/**
 * Every module's jobs. Each module owns its own `jobs.ts`; a new module's jobs
 * are added here.
 */
export const allJobs: JobDefinition[] = [
  ...spaceJobs,
  ...syncJobs,
  ...journalJobs,
  ...analyzerJobs,
  ...assetJobs,
  ...planJobs,
  ...releaseJobs,
  ...packageIoJobs,
  ...auditJobs,
  ...auditReportJobs,
  ...revisionJobs,
  ...verifyJobs,
] as JobDefinition[];
