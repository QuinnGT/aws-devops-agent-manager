import type { Policy } from "@/server/policy";
import type { NormBundle } from "./normalize";

/**
 * One file of an instruction package, as the package readers produce it.
 * assetType is the asset type ("memory", "skill", ...); name is the asset
 * name (memory store name for memories, skill name for skills); path is the
 * file's path inside the asset; body is its text.
 */
export interface PackageFile {
  assetType: string;
  name: string;
  path: string;
  body: string;
}

export interface AnalyzerContext {
  policy: Pick<Policy, "outputRules" | "analyzers">;
  /** Package files for analyzers that compare a journal with a package */
  packageFiles?: PackageFile[] | null;
}

/** What an analyzer needs besides the journal. */
export type AnalyzerRequirement = "package";

export interface Analyzer<O = unknown> {
  /** Stable id, stored in analyzer_runs.analyzer */
  id: string;
  /** Bump when the logic or the built-in defaults change, so stored output is recomputed */
  version: string;
  label: string;
  description: string;
  requires: AnalyzerRequirement[];
  /** Digest of configuration the output depends on (policy rules, package files). Included in the input digest. */
  configDigest(ctx: AnalyzerContext): string;
  run(bundle: NormBundle, ctx: AnalyzerContext): O;
}
