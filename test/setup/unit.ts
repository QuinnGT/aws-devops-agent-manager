import path from "node:path";
import { resetEnvForTests } from "@/server/env";
import { resetPolicyCacheForTests } from "@/server/policy/loader";

// Unit tests: no database, no network, no AWS. Policy comes from the repo's policy/ dir.
process.env.DAM_POLICY_DIR = path.resolve(__dirname, "../../policy");
// A shell setting must not change the suites. DAM_TEST_POLICY_OVERLAY_DIRS, when set, runs them with that overlay on purpose.
process.env.DAM_POLICY_OVERLAY_DIRS = process.env.DAM_TEST_POLICY_OVERLAY_DIRS ?? "";
process.env.DAM_DATA_DIR = path.resolve(__dirname, "../../data/test-unit");
process.env.AWS_EC2_METADATA_DISABLED = "true";
resetEnvForTests();
resetPolicyCacheForTests();
