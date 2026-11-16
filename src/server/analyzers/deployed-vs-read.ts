import { createHash } from "node:crypto";
import { pySplitLines, type NormBundle } from "./normalize";
import { pyRegex } from "./py";
import type { Analyzer, PackageFile } from "./types";

/**
 * Deployed vs read.
 *
 * For each package file: whether the agent requested the matching deployed
 * path, and whether a body it received matches the file. Two shares are
 * computed over the start of each body (exports clip long results):
 *   pkg = package lines present in the returned body
 *   ret = returned lines present in the package file
 * Both near 100% means the deployed body matches this package.
 *
 * Package input: PackageFile[]. For memories, `name` is the
 * memory store and `path` the file inside it; for skills, `name` is the skill
 * and `path` the file inside it. Deployed paths come from the templates below.
 */

export const DEPLOYED_VS_READ_DEFAULTS = {
  /** Deployed path per asset type; {name} and {path} are replaced */
  deployedPaths: { memory: "/aidevops/memory/{name}/{path}", skill: "/aidevops/skills/user/{name}/{path}" } as Record<string, string>,
  /** Per asset type, only these file paths are compared (empty or missing: all) */
  onlyPaths: { skill: ["SKILL.md"] } as Record<string, string[]>,
  /** File names never compared (store descriptions and generated indexes) */
  skipFileNames: ["STORE.md", "INDEX.md"],
  /** Prefix for "is this store referenced anywhere"; {store} is replaced */
  storeMarker: "/aidevops/memory/{store}/",
  linePrefix: String.raw`^\s*\d+\t`,
  clipChars: 1500,
  minLineChars: 25,
  truncatedMarker: "... (truncated",
  matchShare: 0.98,
  nearShare: 0.9,
  minOverlapLines: 2,
  minOverlapShare: 0.3,
  diffLinesShown: 2,
  diffLineChars: 104,
};

export type DeployedVerdict = "matches" | "near" | "different" | "requested-no-body" | "not-read";

export interface DeployedFileResult {
  assetType: string;
  name: string;
  path: string;
  deployedPath: string;
  read: boolean;
  /** Records where the path was requested or mentioned */
  readAt: number[];
  pkg: number | null;
  ret: number | null;
  verdict: DeployedVerdict;
  /** Record whose returned body matched best */
  returnedAt: number | null;
  packageOnly: string[];
  deployedOnly: string[];
}

export interface DeployedVsReadOutput {
  incident: string;
  packageFiles: number;
  packageDigest: string;
  stores: { store: string; referenced: boolean }[];
  files: DeployedFileResult[];
  counts: Record<DeployedVerdict, number>;
}

/** Frontmatter dropped, start of the body, meaningful lines only. */
export function bodyLines(text: string, d = DEPLOYED_VS_READ_DEFAULTS): string[] {
  const lead = text.replace(/^\s+/, "");
  if (lead.startsWith("---")) {
    const first = lead.indexOf("---");
    const second = lead.indexOf("---", first + 3);
    if (second !== -1) text = lead.slice(second + 3);
  }
  const lines: string[] = [];
  let used = 0;
  for (const raw of pySplitLines(text)) {
    const line = raw.trim();
    used += [...line].length + 1;
    if (used > d.clipChars || line.startsWith(d.truncatedMarker)) break;
    if ([...line].length >= d.minLineChars && ![...line].every((c) => "|-: ".includes(c))) lines.push(line);
  }
  return lines;
}

export function deployedPathOf(f: PackageFile, d = DEPLOYED_VS_READ_DEFAULTS): string | null {
  const tpl = d.deployedPaths[f.assetType];
  if (!tpl) return null;
  return tpl.replace("{name}", f.name).replace("{path}", f.path.replace(/^\/+/, ""));
}

function digestFiles(files: PackageFile[]): string {
  const h = createHash("sha256");
  for (const f of [...files].sort((a, b) => `${a.assetType}/${a.name}/${a.path}`.localeCompare(`${b.assetType}/${b.name}/${b.path}`))) {
    h.update(`${f.assetType}\0${f.name}\0${f.path}\0${f.body}\0`);
  }
  return h.digest("hex");
}

export function deployedVsRead(b: NormBundle, files: PackageFile[], d = DEPLOYED_VS_READ_DEFAULTS): DeployedVsReadOutput {
  const prefix = pyRegex(d.linePrefix, "gm");
  const corpusParts: { n: number; text: string }[] = [];
  const returned: { n: number; lines: string[]; set: Set<string> }[] = [];
  for (const r of b.records) {
    corpusParts.push({ n: r.n, text: [r.text, ...r.thinking, ...r.toolUses.map((u) => JSON.stringify(u.input) ?? "")].join("\n") });
    const bodies = r.toolResults.map((t) => t.text);
    if (r.isMessage && !r.structured && r.role === "user") bodies.push(r.text);
    for (const body of bodies) {
      const lines = bodyLines(body.replace(prefix, ""), d);
      if (lines.length) returned.push({ n: r.n, lines, set: new Set(lines) });
    }
  }

  const targets = files.filter((f) => {
    const base = f.path.split("/").pop() ?? f.path;
    if (d.skipFileNames.includes(base)) return false;
    const only = d.onlyPaths[f.assetType];
    return !only?.length || only.includes(f.path);
  });

  const results: DeployedFileResult[] = [];
  for (const f of targets) {
    const deployedPath = deployedPathOf(f, d);
    if (!deployedPath) continue;
    const readAt = corpusParts.filter((p) => p.text.includes(deployedPath)).map((p) => p.n);
    const mine = bodyLines(f.body, d);
    const mineSet = new Set(mine);
    let best: { pkg: number; ret: number; n: number; lines: string[]; set: Set<string> } | null = null;
    for (const theirs of returned) {
      const overlap = mine.filter((l) => theirs.set.has(l)).length;
      if (!mine.length || overlap < Math.max(d.minOverlapLines, d.minOverlapShare * mine.length)) continue;
      const pkg = overlap / mine.length;
      const ret = theirs.lines.filter((l) => mineSet.has(l)).length / theirs.lines.length;
      if (!best || pkg + ret > best.pkg + best.ret) best = { pkg, ret, ...theirs };
    }
    const read = readAt.length > 0;
    if (!best) {
      results.push({
        assetType: f.assetType,
        name: f.name,
        path: f.path,
        deployedPath,
        read,
        readAt,
        pkg: null,
        ret: null,
        verdict: read ? "requested-no-body" : "not-read",
        returnedAt: null,
        packageOnly: [],
        deployedOnly: [],
      });
      continue;
    }
    const verdict: DeployedVerdict =
      best.pkg >= d.matchShare && best.ret >= d.matchShare ? "matches" : best.pkg >= d.nearShare && best.ret >= d.nearShare ? "near" : "different";
    const cut = (l: string) => [...l].slice(0, d.diffLineChars).join("");
    results.push({
      assetType: f.assetType,
      name: f.name,
      path: f.path,
      deployedPath,
      read,
      readAt,
      pkg: best.pkg,
      ret: best.ret,
      verdict,
      returnedAt: best.n,
      packageOnly: verdict === "matches" ? [] : mine.filter((l) => !best.set.has(l)).slice(0, d.diffLinesShown).map(cut),
      deployedOnly: verdict === "matches" ? [] : best.lines.filter((l) => !mineSet.has(l)).slice(0, d.diffLinesShown).map(cut),
    });
  }

  const corpus = corpusParts.map((p) => p.text).join("\n");
  const stores = [...new Set(targets.filter((f) => f.assetType === "memory").map((f) => f.name))].sort();
  const counts: Record<DeployedVerdict, number> = { matches: 0, near: 0, different: 0, "requested-no-body": 0, "not-read": 0 };
  for (const r of results) counts[r.verdict]++;
  return {
    incident: b.task.incidentId ?? b.task.taskId,
    packageFiles: files.length,
    packageDigest: digestFiles(files),
    stores: stores.map((store) => ({ store, referenced: corpus.includes(d.storeMarker.replace("{store}", store)) })),
    files: results,
    counts,
  };
}

export const deployedVsReadAnalyzer: Analyzer<DeployedVsReadOutput> = {
  id: "deployed-vs-read",
  version: "1.0.0",
  label: "Deployed vs read",
  description: "For each package file, whether the agent requested its deployed path and received a matching body",
  requires: ["package"],
  configDigest: (ctx) => digestFiles(ctx.packageFiles ?? []),
  run: (b, ctx) => deployedVsRead(b, ctx.packageFiles ?? []),
};
