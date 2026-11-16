import path from "node:path";
import { afterAll, beforeAll } from "vitest";
import { closeDatabase } from "@/server/db/client";
import { resetEnvForTests } from "@/server/env";
import { resetPolicyCacheForTests } from "@/server/policy/loader";

// Integration tests need TEST_DATABASE_URL: a disposable database you own.
// See AGENTS.md, "Local services", for creating one on the dev Postgres.
// Run `pnpm db:push` against it first (DATABASE_URL=$TEST_DATABASE_URL pnpm db:push).
const url = process.env.TEST_DATABASE_URL;
if (!url) throw new Error("Set TEST_DATABASE_URL to run integration tests");

process.env.DATABASE_URL = url;
process.env.DAM_POLICY_DIR = path.resolve(__dirname, "../../policy");
// A shell setting must not change the suites. DAM_TEST_POLICY_OVERLAY_DIRS, when set, runs them with that overlay on purpose.
process.env.DAM_POLICY_OVERLAY_DIRS = process.env.DAM_TEST_POLICY_OVERLAY_DIRS ?? "";
process.env.DAM_DATA_DIR = process.env.TEST_DATA_DIR ?? path.resolve(__dirname, "../../data/test-int");
process.env.AWS_EC2_METADATA_DISABLED = "true";
resetEnvForTests();
resetPolicyCacheForTests();

beforeAll(() => {});
afterAll(async () => {
  await closeDatabase();
});
