import { z } from "zod";
import { defineSection } from "./define";

/**
 * Release verification, checks 1 and 2. policy/verify.yaml documents each key.
 */

const liveDefault = { syncFirst: true };

const autoDefault = { enabled: false, release: "latest" as const };

const readsDefault = {
  maxInvestigations: 50,
  window: "release-created" as const,
  managed: "skip" as const,
  inactive: "skip" as const,
  examplesPerFile: 3,
  versionsPerFile: 10,
  auto: autoDefault,
};

export const verifySection = defineSection(
  "verify.yaml",
  z.object({
    live: z
      .object({
        /** Sync the space (a reconcile) before comparing, so the check reads the live space and not the last sync */
        syncFirst: z.boolean().default(liveDefault.syncFirst),
      })
      .default(liveDefault),
    reads: z
      .object({
        /** Most investigations one check reads, newest first */
        maxInvestigations: z.number().int().min(1).max(2000).default(readsDefault.maxInvestigations),
        /**
         * Which investigations ran on the release. release-created: created after
         * the release was created and before the next release was created.
         * content-live: created after the newest asset change in the release and
         * before the newest asset change in the next release.
         */
        window: z.enum(["release-created", "content-live"]).default(readsDefault.window),
        /** Memories in managed stores (asset-types.yaml managedNames): the agent rewrites them, so skip them or compare them like any other */
        managed: z.enum(["skip", "include"]).default(readsDefault.managed),
        /** Inactive skills and memories: the agent can't load them, so skip them or compare them like any other */
        inactive: z.enum(["skip", "include"]).default(readsDefault.inactive),
        /** Example records kept per file and outcome */
        examplesPerFile: z.number().int().min(0).max(20).default(readsDefault.examplesPerFile),
        /** Earlier and later versions of a file compared with a body that isn't the release's, to name the version the agent got */
        versionsPerFile: z.number().int().min(0).max(100).default(readsDefault.versionsPerFile),
        auto: z
          .object({
            /** Queue the check when a journal export or import adds investigations to the space */
            enabled: z.boolean().default(autoDefault.enabled),
            /** latest: the newest release. latest-applied: the newest release tagged after applying a plan */
            release: z.enum(["latest", "latest-applied"]).default(autoDefault.release),
          })
          .default(autoDefault),
      })
      .default(readsDefault),
  }),
);

export type VerifyPolicy = z.output<typeof verifySection.schema>;
