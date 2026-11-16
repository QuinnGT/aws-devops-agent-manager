import { z } from "zod";
import { defineSection } from "./define";

/**
 * Heading patterns for importing markdown journal
 * exports. The existing exports use two formats; policy/journal-import.yaml defines both.
 *
 * Every pattern is a JavaScript regular expression source. The parser compiles
 * patterns with the "m" flag (so ^ and $ match at line boundaries) and reads
 * named groups. A pattern that does not compile rejects the policy load.
 */

function compiles(source: string): boolean {
  try {
    new RegExp(source, "m");
    return true;
  } catch {
    return false;
  }
}

const pattern = z.string().min(1).refine(compiles, "not a valid regular expression");

const format = z.object({
  id: z.string().min(1),
  description: z.string().default(""),
  /** Regex (multiline) matching one record heading line; named groups: type (required), n, time */
  recordHeading: pattern,
  /** Optional regex for a separate created-time line after the heading; named group: time */
  createdLine: pattern.optional(),
  /** Optional regex for the document header (text before the first record); named groups: incident, execution, records, pages */
  documentHeader: pattern.optional(),
  /** Optional regex for a separator line between records (removed from the end of each record) */
  recordSeparator: pattern.optional(),
  /** Optional regex for the role marker on the first line of a message record; named group: role */
  roleLine: pattern.optional(),
  /** Optional regex searched in the whole document for the investigation title; named group: title */
  title: pattern.optional(),
  /** Record types that hold conversation messages */
  messageTypes: z.array(z.string()).default(["message"]),
  /** Optional regex for a thinking block inside a message; named group: thinking */
  thinking: pattern.optional(),
  /** Optional regex for a rendered tool call; named groups: name, input (JSON text) */
  toolCall: pattern.optional(),
  /** Optional regex for a rendered tool result; named groups: status, text */
  toolResult: pattern.optional(),
  /** Keys recovered from a tool call whose JSON input was cut off by the export */
  partialInputKeys: z.array(z.string()).default([]),
});

export type JournalImportFormat = z.output<typeof format>;

export const journalImportSection = defineSection(
  "journal-import.yaml",
  z.object({
    formats: z
      .array(format)
      .default([])
      .refine((f) => new Set(f.map((x) => x.id)).size === f.length, "format ids must be unique"),
  }),
);
