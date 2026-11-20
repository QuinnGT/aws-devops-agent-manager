import type { NormBundle } from "@/server/analyzers/normalize";
import type { ReviewRunInput } from "@/server/audits/contract";
import { prepareReview } from "./prompt";
import { recordTexts, utcTime } from "./records";
import type { ReviewSettings } from "./settings";

/**
 * Review files: one investigation's review as files instead of tool calls, for a
 * reviewer outside the app (hand-off) or a DevOps Agent chat with the files
 * attached. The brief is the same policy template as the Bedrock review, filled
 * in "files" mode, so {{record_access}} points to records.md.
 *
 * records.md holds every record under a `## R<n> <TYPE> <UTC time>` heading.
 * Each record's text is recordText, the text the citation check searches, so a
 * quote copied from records.md passes the check. A record longer than
 * recordCharsCap is cut with a note; quotes from the part shown still pass.
 */

export const REVIEW_FILE_NAMES = { system: "system.md", brief: "brief.md", schema: "schema.json", records: "records.md" } as const;

export interface ReviewFiles {
  system: string;
  brief: string;
  /** The output schema as sent to a model (without $schema and $id), as JSON text */
  schema: string;
  records: string;
  /** The parsed output schema from policy, for validateOutput */
  schemaObject: Record<string, unknown>;
  /** SHA-256 over system, brief and schema (prepareReview's digest) */
  promptDigest: string;
  /** Records whose text was cut in records.md */
  recordsCut: number;
}

/** records.md for one investigation: every record in order, each cut at `cap` characters. */
export function recordsMarkdown(bundle: NormBundle, cap: number): { text: string; cut: number } {
  const texts = recordTexts(bundle);
  let cut = 0;
  const parts = bundle.records.map((r, i) => {
    let body = texts[i] ?? "";
    if (body.length > cap) {
      cut++;
      body = `${body.slice(0, cap)}\n[Cut by the app: ${body.length - cap} more characters of this record are not shown.]`;
    }
    return `## R${r.n} ${r.recordType.toUpperCase()} ${utcTime(r.createdAt)}\n\n${body}`;
  });
  return { text: `${parts.join("\n\n")}\n`, cut };
}

/** The review files for one investigation. Throws ReviewSetupError for a policy problem, like prepareReview. */
export function reviewFiles(input: ReviewRunInput, s: ReviewSettings): ReviewFiles {
  const p = prepareReview(input, s, "files");
  const records = recordsMarkdown(input.bundle, s.files.recordCharsCap);
  return {
    system: p.system,
    brief: p.prompt,
    schema: `${JSON.stringify(p.modelSchema, null, 2)}\n`,
    records: records.text,
    schemaObject: p.schema,
    promptDigest: p.promptDigest,
    recordsCut: records.cut,
  };
}
