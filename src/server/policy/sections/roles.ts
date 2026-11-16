import { z } from "zod";
import { defineSection } from "./define";

/** Roles and the permissions each grants. */

export const PERMISSIONS = [
  "assets.read",
  "history.read",
  "journals.read",
  "journals.export",
  "audits.read",
  "journals.import",
  "sync.run",
  "reasons.write",
  "drafts.write",
  "plans.create",
  "audits.run",
  "findings.review",
  "revisions.build",
  "plans.approve",
  "plans.apply",
  "rollbacks.apply",
  "revisions.apply",
  "releases.create",
  "spaces.manage",
  "policy.edit",
  "bindings.manage",
  "replays.start",
  "auditlog.read",
] as const;

export type Permission = (typeof PERMISSIONS)[number];

const role = z.object({
  description: z.string().default(""),
  /** Roles whose permissions this role also gets */
  inherits: z.array(z.string()).default([]),
  permissions: z.array(z.enum(PERMISSIONS)).default([]),
  /** Rank for "highest role wins" when several bindings apply */
  rank: z.number().int(),
});

export const rolesSection = defineSection(
  "roles.yaml",
  z.object({
    roles: z.record(z.string(), role).refine((r) => Object.keys(r).length > 0, "at least one role"),
  }),
);
