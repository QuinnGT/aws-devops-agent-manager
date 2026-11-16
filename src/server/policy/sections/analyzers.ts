import { z } from "zod";
import { pyRegex } from "@/server/analyzers/py";
import { defineSection } from "./define";

/**
 * Settings for the analyzers in src/server/analyzers/. Today only the memory
 * reads analyzer has any. They describe how a particular Agent Space names its
 * memories, so a history repository or an overlay folder can change them.
 *
 * Patterns are regular expressions in the dialect the analyzer compiles them
 * with (Python's `re`, as `pyRegex` reads it). One that does not compile
 * rejects the policy load.
 */

function compiles(source: string, flags = ""): boolean {
  try {
    pyRegex(source, flags);
    return true;
  } catch {
    return false;
  }
}

const pattern = z.string().min(1).refine((s) => compiles(s), "not a valid regular expression");

/**
 * One rule that names the kind of an index listing. The first rule whose
 * conditions all hold wins; a rule with no condition matches every listing.
 */
const indexClass = z.object({
  /** The kind the listing gets in the analyzer's output ("indexes_read" keys) */
  kind: z.string().min(1),
  /** Append the first N entry names to the kind (for example "other-dir:deps/,flows/") */
  appendNames: z.number().int().positive().optional(),
  /** Some entry name starts with this */
  anyNamePrefix: z.string().min(1).optional(),
  /** Some entry name is one of these */
  anyNameIn: z.array(z.string().min(1)).min(1).optional(),
  /** Some entry's link target ends with this */
  anyTargetSuffix: z.string().min(1).optional(),
  /** The entries' descriptions, lowercased and joined with spaces, include this text */
  descriptionsInclude: z.string().min(1).optional(),
  /** The listing has at least this many entries */
  minEntries: z.number().int().positive().optional(),
});

export type IndexClassRule = z.output<typeof indexClass>;

const memoryReads = z.object({
  /** One entry line of an index listing: groups are the entry number, the name, the link target and the description */
  entry: pattern,
  /** A requested path quoted in text ("file_path": "..."); group 1 is the path */
  filePath: pattern,
  /** Keys of a tool call's input that hold a requested path */
  filePathKeys: z.array(z.string().min(1)).min(1),
  /** A path counts as a memory path when it contains this text */
  memoryPathMarker: z.string().min(1),
  /** A tool result saying a file was not found; group 1 is the path */
  fileNotFound: pattern,
  /** Text that marks a record as holding the failure-pattern memory's content. Empty: no such memory is tracked */
  failpatContent: z.string().default(""),
  /** Name of the failure-pattern memory as an index entry lists it. Empty: no such memory is tracked */
  failpatName: z.string().default(""),
  /** Rules that name the kind of an index listing, first match wins */
  classes: z.array(indexClass).default([]),
  /** The kind of a listing no rule matches, with the first `fallbackNames` entry names appended */
  fallbackKind: z.string().min(1),
  fallbackNames: z.number().int().nonnegative(),
});

export type MemoryReadsSettings = z.output<typeof memoryReads>;

export const analyzersSection = defineSection(
  "analyzers.yaml",
  z.object({
    memoryReads,
  }),
);
