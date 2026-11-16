import { z } from "zod";
import { defineSection } from "./define";

/**
 * Output rules checked on agent output and on
 * report exports (account ID masking, DESTRUCTIVE labels, other patterns).
 *
 * Patterns are JavaScript regular expressions. `flags` is any of "i", "m",
 * "s", "u"; the checker adds "g". A pattern that does not compile rejects the
 * policy load.
 */

function compiles(source: string, flags = ""): boolean {
  try {
    new RegExp(source, flags);
    return true;
  } catch {
    return false;
  }
}

const flags = z
  .string()
  .regex(/^[imsu]*$/, "flags may only contain i, m, s and u")
  .default("");

const rule = z
  .object({
    id: z.string().min(1),
    description: z.string(),
    kind: z.enum(["forbid", "require-near"]),
    pattern: z.string().min(1),
    flags,
    /** For require-near: a pattern that must appear within `window` characters before or after each match */
    requires: z.string().optional(),
    requiresFlags: flags,
    window: z.number().int().positive().optional(),
    severity: z.enum(["error", "warning"]).default("error"),
    /** Where the rule applies: agent output in journals, report exports, or both */
    appliesTo: z.array(z.enum(["agent-output", "report"])).default(["agent-output", "report"]),
    /** Matches that fully match one of these patterns are allowed (for example a documented placeholder) */
    allow: z.array(z.string()).default([]),
    /** How the match is shown in findings: as found, with all but the last 4 digits masked, or hidden */
    redact: z.enum(["none", "mask-digits", "hide"]).default("none"),
  })
  .superRefine((r, ctx) => {
    if (!compiles(r.pattern, r.flags)) ctx.addIssue({ code: "custom", path: ["pattern"], message: "not a valid regular expression" });
    if (r.kind === "require-near") {
      if (!r.requires) ctx.addIssue({ code: "custom", path: ["requires"], message: "require-near rules need `requires`" });
      else if (!compiles(r.requires, r.requiresFlags)) ctx.addIssue({ code: "custom", path: ["requires"], message: "not a valid regular expression" });
      if (!r.window) ctx.addIssue({ code: "custom", path: ["window"], message: "require-near rules need `window`" });
    }
    r.allow.forEach((a, i) => {
      if (!compiles(a)) ctx.addIssue({ code: "custom", path: ["allow", i], message: "not a valid regular expression" });
    });
  });

export type OutputRule = z.output<typeof rule>;

export const outputRulesSection = defineSection(
  "output-rules.yaml",
  z.object({
    rules: z
      .array(rule)
      .default([])
      .refine((r) => new Set(r.map((x) => x.id)).size === r.length, "rule ids must be unique"),
    /** Which journal records count as agent output */
    agentOutput: z
      .object({
        recordTypes: z.array(z.string()).default([]),
        /** Message roles checked (text only, not tool calls) */
        messageRoles: z.array(z.string()).default([]),
        /** Imported messages can lack a role; check them too when true */
        includeMessagesWithoutRole: z.boolean().default(false),
      })
      .prefault({}),
    /** Characters of context shown on each side of a match */
    excerptChars: z.number().int().positive().default(80),
  }),
);
