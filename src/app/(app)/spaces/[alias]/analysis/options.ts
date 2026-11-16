import "server-only";
import { ANALYZERS } from "@/server/analyzers/registry";
import type { AnalyzerOption } from "./run-analyzers";

/** Analyzer choices shown in the UI, in registry order. */
export function analyzerOptions(): AnalyzerOption[] {
  return ANALYZERS.map((a) => ({ id: a.id, label: a.label, description: a.description, needsPackage: a.requires.includes("package") }));
}
