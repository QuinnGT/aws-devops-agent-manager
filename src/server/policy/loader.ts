import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { parse as parseYaml } from "yaml";
import { env } from "@/server/env";
import { type Policy, policySections } from "./sections";

/**
 * Loads policy files at runtime and validates them with Zod.
 *
 * Layering, lowest precedence first: the app repository's policy/ directory
 * (DAM_POLICY_DIR) holds defaults; the directories in DAM_POLICY_OVERLAY_DIRS
 * come next, in the order listed; a history repository's policy/ directory
 * overrides all of them. Objects are deep-merged, arrays and scalars are
 * replaced. A section that fails validation rejects the whole load (never
 * half-applied).
 */

export class PolicyError extends Error {
  constructor(
    message: string,
    readonly issues: { section: string; file: string; detail: string }[],
  ) {
    super(message);
    this.name = "PolicyError";
  }
}

export interface LoadedPolicy {
  policy: Policy;
  /** SHA-256 over the raw files that produced this policy */
  digest: string;
  /** Directories read, lowest precedence first */
  dirs: string[];
}

type Plain = Record<string, unknown>;

function isPlain(v: unknown): v is Plain {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

export function deepMerge(base: unknown, over: unknown): unknown {
  if (over === undefined) return base;
  if (isPlain(base) && isPlain(over)) {
    const out: Plain = { ...base };
    for (const [k, v] of Object.entries(over)) out[k] = deepMerge(base[k], v);
    return out;
  }
  return over;
}

function readSection(dir: string, file: string): { raw: string; data: unknown } | null {
  const p = path.join(/*turbopackIgnore: true*/ dir, file);
  if (!existsSync(p)) return null;
  const raw = readFileSync(p, "utf8");
  return { raw, data: parseYaml(raw) ?? {} };
}

/** Load and validate policy from one or more directories (later ones win). */
export function loadPolicyFromDirs(dirs: string[]): LoadedPolicy {
  const hash = createHash("sha256");
  const issues: PolicyError["issues"] = [];
  const out: Partial<Record<keyof Policy, unknown>> = {};
  const existing = dirs.filter((d) => existsSync(d));

  for (const [key, section] of Object.entries(policySections) as [keyof Policy, (typeof policySections)[keyof Policy]][]) {
    let merged: unknown = {};
    for (const dir of existing) {
      const s = readSection(dir, section.file);
      if (!s) continue;
      hash.update(`${dir}/${section.file}\0${s.raw}\0`);
      merged = deepMerge(merged, s.data);
    }
    const parsed = section.schema.safeParse(merged);
    if (!parsed.success) {
      for (const issue of parsed.error.issues) {
        issues.push({ section: key, file: section.file, detail: `${issue.path.join(".") || "(root)"}: ${issue.message}` });
      }
      continue;
    }
    out[key] = parsed.data;
  }

  if (issues.length) {
    throw new PolicyError(`Policy rejected: ${issues.length} problem(s)`, issues);
  }
  return { policy: out as Policy, digest: hash.digest("hex"), dirs: existing };
}

/** Read a text file that belongs to policy (templates, prompts), searching later dirs first. */
export function readPolicyFile(dirs: string[], relPath: string): string | null {
  if (relPath.includes("..") || path.isAbsolute(relPath)) throw new Error(`invalid policy path: ${relPath}`);
  for (const dir of [...dirs].reverse()) {
    const p = path.join(/*turbopackIgnore: true*/ dir, relPath);
    if (existsSync(p)) return readFileSync(p, "utf8");
  }
  return null;
}

let appPolicy: LoadedPolicy | undefined;
const warnedMissing = new Set<string>();

/**
 * The default directory and the configured overlay directories, lowest
 * precedence first. A missing overlay is skipped by loadPolicyFromDirs; each
 * one is reported once per process so a typo in the setting is visible.
 */
function baseDirs(): string[] {
  const { policyDir, policyOverlayDirs } = env();
  for (const dir of policyOverlayDirs) {
    if (existsSync(dir) || warnedMissing.has(dir)) continue;
    warnedMissing.add(dir);
    console.warn(`[policy] DAM_POLICY_OVERLAY_DIRS lists ${dir}, which does not exist. It is ignored.`);
  }
  return [policyDir, ...policyOverlayDirs];
}

/** Defaults from DAM_POLICY_DIR with the DAM_POLICY_OVERLAY_DIRS directories merged over them. Cached per process. */
export function getAppPolicy(): LoadedPolicy {
  appPolicy ??= loadPolicyFromDirs(baseDirs());
  return appPolicy;
}

const overlayCache = new Map<string, LoadedPolicy>();

/**
 * Policy for a history repository: the app policy (defaults and overlay
 * directories) overlaid with the repository's policy/ directory at its working
 * copy. Pass the working copy path.
 */
export function getPolicyForRepo(workingDir: string | null | undefined, policySubdir = "policy"): LoadedPolicy {
  if (!workingDir) return getAppPolicy();
  const dirs = [...baseDirs(), path.join(/*turbopackIgnore: true*/ workingDir, policySubdir)];
  const loaded = loadPolicyFromDirs(dirs);
  const cached = overlayCache.get(loaded.digest);
  if (cached) return cached;
  overlayCache.set(loaded.digest, loaded);
  return loaded;
}

export function resetPolicyCacheForTests(): void {
  appPolicy = undefined;
  overlayCache.clear();
  warnedMissing.clear();
}
