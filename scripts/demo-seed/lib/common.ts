import path from "node:path";
import { SAMPLE_DATA_DIR } from "../../../test/helpers/fixtures";

/**
 * Names, people and paths shared by the demo seeds (scripts/demo-seed/*.ts).
 * Everything comes from the sample dataset in sample-data/ (see its README):
 * the fictional AnyCompany Tickets. Nothing here talks to AWS or a model.
 */

export const ALIAS = "anycompany-tickets";
export const DISPLAY_NAME = "AnyCompany Tickets (sample)";
/** The history repository of the demo space, under DAM_DATA_DIR/history */
export const REPO_NAME = "anycompany-tickets-history";
/** The sample Agent Space (sample-data/README.md) */
export const AGENT_SPACE_ID = "00000000-0000-4000-8000-0000000000aa";
export const ACCOUNT_ID = "111122223333";
export const REGION = "us-west-2";
/** A placeholder ID to show the setting; nothing in the app names a real model. */
export const REVIEW_MODEL = "example.reviewer-model";
/** A profile name that doesn't exist, so the dev server never finds AWS credentials for the demo space. */
export const NO_AWS_PROFILE = "dam-demo-no-aws";

export interface SeedPerson {
  email: string;
  name: string;
}

/** The space owner and the admin in the demo. Run the dev server as this person: AUTH_DEV_USER_EMAIL=alex@example.com */
export const ALEX: SeedPerson = { email: "alex@example.com", name: "Alex Rivera" };
export const SAM: SeedPerson = { email: "sam@example.com", name: "Sam Lee" };
export const REVIEWER: SeedPerson = { email: "reviewer@example.com", name: "Reviewer" };

/** Where the sample dataset's folders are. */
export const SAMPLE = {
  root: SAMPLE_DATA_DIR,
  /** The sample policy overlay, committed into the demo space's history repository */
  policyDir: path.join(SAMPLE_DATA_DIR, "policy"),
  /** The audit folder that holds `reviews/INCIDENT-<n>.json` (the reference reviews of the benchmark set) */
  auditDir: path.join(SAMPLE_DATA_DIR, "audit"),
  /** One folder per benchmark incident: journal, root cause document, scorecard */
  benchmarkDir: path.join(SAMPLE_DATA_DIR, "journals", "benchmark"),
};

/** The journal, root cause and scorecard of one benchmark incident (INCIDENT-201xx). */
export function benchmarkFiles(incidentId: string) {
  const dir = path.join(SAMPLE.benchmarkDir, incidentId);
  const n = incidentId.replace("INCIDENT-", "");
  return {
    journal: path.join(dir, `${incidentId}_full_journal.md`),
    rca: path.join(dir, `${n}_actual_rca.md`),
    scorecard: path.join(dir, `${incidentId}_scorecard.md`),
  };
}

export const minutesAgo = (m: number) => new Date(Date.now() - m * 60_000);

export function logger(prefix: string) {
  return (...a: unknown[]) => console.log(`[${prefix}]`, ...a);
}
