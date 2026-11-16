import { createHash } from "node:crypto";
import type { AuditProfile } from "@/server/policy/sections/audits";
import { captureOf, incidentIdFor, policyRegex } from "./profiles";

/**
 * Ground-truth matching. Pure. A file name is matched
 * against each profile input's `fileNamePattern` (first match wins, in profile
 * order); the captured number goes through `incidentIdTemplate`; each field is
 * read from the body with its pattern. Document text is untrusted: it is only
 * stored and searched with the profile's own patterns.
 */

export interface MatchedEvidence {
  matched: true;
  /** Path as uploaded (inside a zip: the entry name) */
  path: string;
  fileName: string;
  incidentId: string;
  kind: string;
  label: string;
  fields: Record<string, string | null>;
  body: string;
  sha256: string;
  sizeBytes: number;
}

export interface UnmatchedEvidence {
  matched: false;
  path: string;
  fileName: string;
  reason: string;
  /** Stable reason code for the page, e.g. "evidence.name-unmatched" */
  code?: EvidenceReasonCode;
}

export type EvidenceReasonCode = "evidence.system-file" | "evidence.name-unmatched" | "evidence.no-incident-number" | "evidence.not-text" | "evidence.duplicate";

export type EvidenceMatch = MatchedEvidence | UnmatchedEvidence;

export const baseName = (p: string) => p.split(/[\\/]/).pop() ?? p;

/** Files a zip tool adds that are never documents. */
export function isSystemFile(path: string): boolean {
  const name = baseName(path);
  return path.startsWith("__MACOSX/") || path.includes("/__MACOSX/") || name.startsWith("._") || name === ".DS_Store" || name === "Thumbs.db";
}

/** UTF-8 text without NUL characters, or null. */
export function decodeText(bytes: Uint8Array): string | null {
  if (bytes.includes(0)) return null;
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes).replace(/^\uFEFF/, "");
  } catch {
    return null;
  }
}

type Input = AuditProfile["inputs"][number];

/** The input whose file name pattern matches, with the captured incident number. */
export function inputForFileName(profile: Pick<AuditProfile, "inputs">, fileName: string): { input: Input; captured: string | null } | null {
  for (const input of profile.inputs) {
    const m = policyRegex(input.fileNamePattern, "", `file name pattern for ${input.label}`).exec(fileName);
    if (m) return { input, captured: captureOf(m, "id") };
  }
  return null;
}

/** Field values read from a document body with the input's patterns; null when a pattern does not match. */
export function readFields(input: Pick<Input, "fields" | "label">, body: string): Record<string, string | null> {
  const out: Record<string, string | null> = {};
  for (const [name, f] of Object.entries(input.fields)) {
    const v = captureOf(policyRegex(f.pattern, "", `pattern for ${input.label} field ${f.label}`).exec(body), "value");
    out[name] = v === null ? null : v.trim() || null;
  }
  return out;
}

/** Why a file name matches no input, naming what the profile expects. */
function noInputReason(profile: Pick<AuditProfile, "inputs">): string {
  if (!profile.inputs.length) return "This audit profile takes no ground-truth documents.";
  return `The file name matches no document this profile takes (${profile.inputs.map((i) => i.label).join(", ")}).`;
}

/** Match one file. `text` is the decoded body, or null when the file is not UTF-8 text. */
export function matchEvidenceFile(profile: Pick<AuditProfile, "inputs" | "incidentIdTemplate">, path: string, text: string | null): EvidenceMatch {
  const fileName = baseName(path);
  const no = (reason: string, code: EvidenceReasonCode): UnmatchedEvidence => ({ matched: false, path, fileName, reason, code });
  if (isSystemFile(path)) return no("A file added by the zip tool; ignored.", "evidence.system-file");
  const hit = inputForFileName(profile, fileName);
  if (!hit) return no(noInputReason(profile), "evidence.name-unmatched");
  if (!hit.captured) return no(`The file name matches ${hit.input.label} but the pattern captured no incident number.`, "evidence.no-incident-number");
  if (text === null) return no("The file is not UTF-8 text.", "evidence.not-text");
  const body = text.replace(/\u0000/g, "");
  const bytes = Buffer.from(body, "utf8");
  return {
    matched: true,
    path,
    fileName,
    incidentId: incidentIdFor(profile, hit.captured),
    kind: hit.input.kind,
    label: hit.input.label,
    fields: readFields(hit.input, body),
    body,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    sizeBytes: bytes.length,
  };
}

/**
 * Keep the first file per incident and kind; a later one in the same upload
 * is reported as unmatched, naming the file that was kept.
 */
export function dedupeMatches(matches: EvidenceMatch[]): EvidenceMatch[] {
  const first = new Map<string, MatchedEvidence>();
  return matches.map((m) => {
    if (!m.matched) return m;
    const key = `${m.incidentId}\0${m.kind}`;
    const kept = first.get(key);
    if (!kept) {
      first.set(key, m);
      return m;
    }
    return { matched: false, path: m.path, fileName: m.fileName, reason: `Another file in this upload is the ${m.label} for ${m.incidentId} (${kept.path}).`, code: "evidence.duplicate" };
  });
}
