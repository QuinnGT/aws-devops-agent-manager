import type { JobDefinition } from "@/server/jobs/registry";
import { expireUploadsJob } from "./expire";

/** Jobs for the package import and export module. */
export const jobs: JobDefinition[] = [expireUploadsJob] as JobDefinition[];
