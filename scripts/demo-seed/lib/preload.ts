import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Import first in a demo seed, before any app module.
 *
 * - DAM_PROCESS=worker: commits to the history repository and writes to the
 *   (mocked) Agent Space happen only in the worker process.
 * - No instance metadata lookups for credentials.
 * - test/helpers/fixtures.ts resolves its folders with __dirname, which an ES
 *   module doesn't have; give it the folder it expects.
 * - HOME points at a folder of the seed's own with a git identity. The history
 *   repository's git calls get HOME and nothing else of the environment, and
 *   git writes the committer identity from the user's config into the branch
 *   reflogs (.git/logs). Without this, the demo repository would carry the
 *   name and email of whoever ran the seed.
 */
process.env.DAM_PROCESS = "worker";
process.env.AWS_EC2_METADATA_DISABLED = "true";
(globalThis as { __dirname?: string }).__dirname ??= fileURLToPath(new URL("../../../test/helpers/", import.meta.url));

const seedHome = path.resolve(process.env.DAM_DATA_DIR ?? "./data", "seed-home");
mkdirSync(seedHome, { recursive: true });
writeFileSync(path.join(seedHome, ".gitconfig"), "[user]\n\tname = Demo seed\n\temail = seed@example.com\n");
process.env.HOME = seedHome;
