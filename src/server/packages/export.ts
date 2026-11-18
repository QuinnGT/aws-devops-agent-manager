import { isDeepStrictEqual } from "node:util";
import { getAppPolicy, type Policy } from "@/server/policy";
import type { AssetFoldersRule } from "@/server/policy/sections/package-layouts";
import { computeIdentity } from "@/server/validation/identity";
import { error, warning, type ValidationResult } from "@/server/validation/types";
import { buildRelease, zipPackage, type BuildResult } from "./build";
import { packageToDesiredAssets } from "./desired";
import { hasFrontmatter, parseFrontmatter, renderFrontmatter } from "./frontmatter";
import { agentTypeDisplayName, agentTypeResolver, getLayout, parseAgentTypes, sharedSections, type PackageLayout } from "./layout";
import { renderManifest, type PackageManifest } from "./manifest";
import { comparePaths, fill, pathProblem } from "./paths";
import { normalizePackage } from "./read";
import { assetKeyOf, type DesiredAsset, type DesiredFile, type PackageContents } from "./types";

/**
 * Turn desired assets back into a package in the layout (the inverse of
 * packageToDesiredAssets), then build and zip it. Used to download a revision
 * or a live space as a package for a space the app can't write to.
 */

export interface ExportOptions {
  /** Defaults to getAppPolicy().policy */
  policy?: Policy;
  /** Package (and zip top folder) name; defaults to base.name or the layout name */
  packageName?: string;
  /**
   * An existing package to start from (for example the revision's files):
   * its non-asset files (README, evaluation/, reference/) are kept, and its
   * asset files are replaced by the desired assets.
   */
  base?: PackageContents;
}

export interface ExportResult {
  /** True when every asset was placed and the package checks passed */
  ok: boolean;
  contents: PackageContents;
  zip: Buffer;
  fileName: string;
  /** Export problems plus build and validation results */
  results: ValidationResult[];
  build: BuildResult;
}

/** Place desired assets into package files. Returns the package before the build step. */
export function desiredAssetsToPackage(
  desired: readonly DesiredAsset[],
  layoutOrName?: PackageLayout | string,
  opts: ExportOptions = {},
): { contents: PackageContents; results: ValidationResult[] } {
  const policy = opts.policy ?? getAppPolicy().policy;
  const layout = typeof layoutOrName === "object" ? layoutOrName : getLayout(policy, layoutOrName);
  const results: ValidationResult[] = [];
  const files = new Map<string, Buffer>();
  const name = opts.packageName ?? opts.base?.name ?? layout.name;

  if (opts.base) {
    const { roles } = packageToDesiredAssets(opts.base, layout, { policy });
    for (const [p, data] of opts.base.files) {
      const role = roles.get(p)?.role;
      if (role !== "asset" && role !== "build-artifact" && role !== "manifest") files.set(p, data);
    }
  }

  const placed = new Set<string>();
  const put = (path: string, content: Buffer, asset: DesiredAsset) => {
    if (placed.has(path)) {
      results.push(error("export.path-conflict", `Two assets map to ${path}.`, { assetKey: assetKeyOf(asset), path }));
      return;
    }
    placed.add(path);
    files.set(path, content);
  };
  const skip = (asset: DesiredAsset, why: string) =>
    results.push(warning("export.not-placed", `${assetKeyOf(asset)} is not in the package: ${why}`, { assetKey: assetKeyOf(asset) }));

  const byId = new Map(desired.filter((d) => d.assetId).map((d) => [d.assetId!, d]));
  const lookup = (assetType: string, id: string) => {
    const a = byId.get(id);
    return a && a.assetType === assetType ? (computeIdentity(policy, a) ?? undefined) : undefined;
  };
  const manifest: PackageManifest = { layout: layout.name, assets: [] };
  const remember = (asset: DesiredAsset, derived: readonly string[]) => {
    const entry = policy.assetTypes.assetTypes[asset.assetType];
    const idKeys = new Set(entry?.references.map((r) => r.key) ?? []);
    const isDefault = (k: string, v: unknown) => k in layout.manifestDefaults && isDeepStrictEqual(layout.manifestDefaults[k], v);
    const extra = Object.fromEntries(
      Object.entries(asset.metadata).filter(([k, v]) => v !== undefined && !derived.includes(k) && !idKeys.has(k) && !isDefault(k, v)),
    );
    if (Object.keys(extra).length) manifest.assets.push({ assetType: asset.assetType, key: asset.key, metadata: extra });
  };

  const folders = layout.assetFolders ? new AssetFolderWriter(layout.assetFolders, policy, desired, results, opts.base) : null;
  for (const asset of desired) {
    if (folders?.handles(asset.assetType)) {
      folders.place(asset, put);
      continue;
    }
    const entry = policy.assetTypes.assetTypes[asset.assetType];
    const main = entry ? mainFile(entry.mainFile, asset.files) : undefined;
    switch (asset.assetType) {
      case "agents_md": {
        const rule = layout.instructions;
        const agentType = String(asset.metadata.agent_type ?? "");
        const fileName = rule && Object.entries(rule.files).find(([, t]) => t === agentType)?.[0];
        if (!rule || !fileName) {
          skip(asset, `the layout has no instructions file for agent type ${agentType}.`);
          continue;
        }
        if (!main) {
          skip(asset, "it has no AGENTS.md file.");
          continue;
        }
        put(`${rule.dir}/${fileName}`, bytesOf(main), asset);
        remember(asset, ["agent_type"]);
        break;
      }
      case "skill": {
        const rule = layout.skills;
        const skillName = String(asset.metadata.name ?? asset.key);
        if (!rule) {
          skip(asset, "the layout has no skills folder.");
          continue;
        }
        let fmKeys: string[] = [];
        for (const f of asset.files) {
          let data = bytesOf(f);
          if (f.path === rule.mainFile && f.encoding === "utf8") {
            if (!hasFrontmatter(f.content)) {
              const fm: Record<string, unknown> = {};
              for (const [metaKey, fmKey] of Object.entries(rule.frontmatter)) {
                if (["name", "description"].includes(metaKey) && asset.metadata[metaKey] !== undefined) fm[fmKey] = asset.metadata[metaKey];
              }
              data = Buffer.from(renderFrontmatter(fm, f.content), "utf8");
            }
            const parsed = parseFrontmatter(data.toString("utf8")).data ?? {};
            fmKeys = Object.entries(rule.frontmatter).filter(([, fmKey]) => parsed[fmKey] !== undefined).map(([metaKey]) => metaKey);
          }
          put(`${rule.dir}/${skillName}/${f.path}`, data, asset);
        }
        const defaults = rule.agentTypes.bySkill[skillName] ?? rule.agentTypes.default;
        if (!fmKeys.includes("agent_types") && defaults.length && isDeepStrictEqual(asset.metadata.agent_types, defaults)) fmKeys.push("agent_types");
        remember(asset, fmKeys);
        break;
      }
      case "memory_store": {
        const rule = layout.memory;
        if (!rule) {
          skip(asset, "the layout has no memory folder.");
          continue;
        }
        const storeName = String(asset.metadata.name ?? asset.key);
        const fm: Record<string, unknown> = {};
        for (const [metaKey, fmKey] of Object.entries(rule.storeFrontmatter)) {
          const v = asset.metadata[metaKey];
          if (v === undefined) continue;
          fm[fmKey] = metaKey === "agent_types" && Array.isArray(v) ? v.map((id) => agentTypeDisplayName(layout, String(id))).join(", ") : v;
        }
        const storeId = asset.assetId ?? asset.sourceAssetId;
        if (rule.storeAssetIdKey && storeId) fm[rule.storeAssetIdKey] = storeId;
        const body = main?.encoding === "utf8" ? main.content : "";
        const storePath = `${rule.dir}/${storeName}/${rule.storeFile}`;
        const baseStore = opts.base?.files.get(storePath);
        // Keep the base file's own formatting when it already says the same thing.
        const keep = baseStore && storeFileMatches(baseStore, asset, body, layout, policy);
        put(storePath, keep ? baseStore : Buffer.from(renderFrontmatter(fm, `\n${body}`), "utf8"), asset);
        remember(asset, Object.keys(rule.storeFrontmatter));
        break;
      }
      case "memory": {
        const rule = layout.memory;
        if (!rule) {
          skip(asset, "the layout has no memory folder.");
          continue;
        }
        const ref = asset.refs?.memoryStore;
        const id = asset.metadata.memory_store_id;
        const store = typeof ref === "string" && ref ? ref : typeof id === "string" ? lookup("memory_store", id) : undefined;
        if (!store) {
          skip(asset, "its memory store is unknown (set refs.memoryStore).");
          continue;
        }
        if (!main || main.encoding !== "utf8") {
          skip(asset, "it has no text file.");
          continue;
        }
        const memoryName = String(asset.metadata.name ?? "");
        let text = main.content;
        if (!hasFrontmatter(text)) {
          const fm: Record<string, unknown> = {};
          for (const [metaKey, fmKey] of Object.entries(rule.memoryFrontmatter)) if (asset.metadata[metaKey] !== undefined) fm[fmKey] = asset.metadata[metaKey];
          text = renderFrontmatter(fm, text);
        }
        put(`${rule.dir}/${store}/${memoryName}.md`, Buffer.from(text, "utf8"), asset);
        remember(asset, Object.keys(rule.memoryFrontmatter));
        break;
      }
      case "custom_agent": {
        const rule = layout.customAgents;
        if (!rule) {
          skip(asset, "the layout has no custom agents folder.");
          continue;
        }
        const agentName = String(asset.metadata.name ?? asset.key);
        const fm: Record<string, unknown> = {};
        for (const [metaKey, fmKey] of Object.entries(rule.frontmatter)) if (asset.metadata[metaKey] !== undefined) fm[fmKey] = asset.metadata[metaKey];
        for (const [refName, fmKey] of Object.entries(rule.refs)) {
          const v = asset.refs?.[refName];
          if (v !== undefined) fm[fmKey] = Array.isArray(v) ? v : [v];
        }
        for (const f of asset.files) {
          const data = f.path === rule.mainFile && f.encoding === "utf8" ? Buffer.from(renderFrontmatter(fm, f.content), "utf8") : bytesOf(f);
          put(`${rule.dir}/${agentName}/${f.path}`, data, asset);
        }
        remember(asset, Object.keys(rule.frontmatter));
        break;
      }
      default:
        skip(asset, `the layout has no place for ${asset.assetType} assets.`);
    }
  }

  // A shared section's source is not an asset: recover it from the first file that embeds it.
  for (const s of sharedSections(layout)) {
    if (files.has(s.source)) continue;
    for (const target of s.targets) {
      const t = files.get(target)?.toString("utf8");
      const at = t?.indexOf(s.begin) ?? -1;
      const endAt = t && at >= 0 ? t.indexOf(s.end, at + s.begin.length) : -1;
      if (t && at >= 0 && endAt >= 0) {
        files.set(s.source, Buffer.from(`${t.slice(at + s.begin.length, endAt).replace(/^\n+|\n+$/g, "")}\n`, "utf8"));
        break;
      }
    }
  }

  if (folders) {
    const index = folders.index();
    if (index) files.set(index.path, index.data);
  }
  if (layout.manifest && manifest.assets.length) {
    manifest.assets.sort((a, b) => (a.assetType + "\0" + a.key < b.assetType + "\0" + b.key ? -1 : 1));
    files.set(layout.manifest, Buffer.from(renderManifest(manifest), "utf8"));
  }
  return { contents: normalizePackage({ name, files }), results };
}

/** Desired assets -> built package -> deterministic zip in the layout. */
export function exportPackageZip(desired: readonly DesiredAsset[], layoutOrName?: PackageLayout | string, opts: ExportOptions = {}): ExportResult {
  const policy = opts.policy ?? getAppPolicy().policy;
  const layout = typeof layoutOrName === "object" ? layoutOrName : getLayout(policy, layoutOrName);
  const placed = desiredAssetsToPackage(desired, layout, { ...opts, policy });
  const build = buildRelease(placed.contents, layout, { zipLimits: policy.limits.packageRead, packageZip: false });
  const contents = build.contents;
  const fileName = layout.build.packageZip ? fill(layout.build.packageZip, { package: contents.name }) : `${contents.name}.zip`;
  const results = [...placed.results, ...build.results];
  return {
    ok: build.ok && !placed.results.some((r) => r.level === "error"),
    contents,
    zip: zipPackage(contents),
    fileName,
    results,
    build,
  };
}

function storeFileMatches(data: Buffer, asset: DesiredAsset, body: string, layout: PackageLayout, policy: Pick<Policy, "agentTypes">): boolean {
  const parsed = parseFrontmatter(data.toString("utf8"));
  if (!parsed.data || parsed.body.replace(/^(?:\r?\n)+/, "") !== body) return false;
  const resolve = agentTypeResolver(policy, layout);
  const idKey = layout.memory!.storeAssetIdKey;
  if (idKey && (parsed.data[idKey] ?? undefined) !== (asset.assetId ?? asset.sourceAssetId)) return false;
  for (const [metaKey, fmKey] of Object.entries(layout.memory!.storeFrontmatter)) {
    let v: unknown = parsed.data[fmKey] ?? undefined;
    if (metaKey === "agent_types" && v !== undefined) v = parseAgentTypes(v, resolve)?.ids;
    if (!isDeepStrictEqual(v, asset.metadata[metaKey])) return false;
  }
  return true;
}

function mainFile(mainPath: string | undefined, files: readonly DesiredFile[]): DesiredFile | undefined {
  return (mainPath ? files.find((f) => f.path === mainPath) : undefined) ?? (files.length === 1 ? files[0] : undefined);
}

function bytesOf(f: DesiredFile): Buffer {
  return f.encoding === "utf8" ? Buffer.from(f.content, "utf8") : Buffer.from(f.content, "base64");
}

/**
 * Export for Agent Space folder layouts (layout `assetFolders`): each asset
 * of a listed type goes to `<type dir>/<folder>/` with its files as they are
 * and a descriptor holding assetId, assetType and metadata, with references
 * as asset IDs. The folder index lists every folder. Memory types are left
 * to the layout's memory rules.
 */
class AssetFolderWriter {
  private readonly used = new Map<string, Set<string>>();
  private readonly entries: { dir: string; type: string; name: string; assetId?: string; status?: unknown; files: string[] }[] = [];
  private readonly idByIdentity = new Map<string, string>();

  constructor(
    private readonly rule: AssetFoldersRule,
    private readonly policy: Pick<Policy, "assetTypes">,
    desired: readonly DesiredAsset[],
    private readonly results: ValidationResult[],
    private readonly base?: PackageContents,
  ) {
    for (const d of desired) {
      const identity = computeIdentity(policy, d);
      if (d.assetId && identity !== null && !this.idByIdentity.has(`${d.assetType}\0${identity}`)) this.idByIdentity.set(`${d.assetType}\0${identity}`, d.assetId);
    }
  }

  handles(assetType: string): boolean {
    return assetType in this.rule.types;
  }

  place(asset: DesiredAsset, put: (path: string, content: Buffer, asset: DesiredAsset) => void): void {
    const t = this.rule.types[asset.assetType]!;
    const name = typeof asset.metadata.name === "string" && asset.metadata.name ? asset.metadata.name : asset.key;
    const agentType = typeof asset.metadata.agent_type === "string" ? asset.metadata.agent_type : "";
    const agentFolder = this.rule.agentFolders[agentType] ?? agentType.toLowerCase().replace(/_/g, "-");
    const used = this.used.get(t.dir) ?? new Set<string>();
    this.used.set(t.dir, used);
    let folder = fill(t.folder, { name, agentFolder, assetId: asset.assetId ?? "" });
    if (!isFolderName(folder)) folder = asset.assetId && isFolderName(asset.assetId) ? asset.assetId : "asset";
    if (used.has(folder)) {
      const second = fill(this.rule.duplicateFolder, { folder, assetId: asset.assetId ?? "" });
      folder = isFolderName(second) && !used.has(second) ? second : folder;
      for (let n = 2; used.has(folder); n++) folder = `${folder.replace(/-\d+$/, "")}-${n}`;
    }
    used.add(folder);
    const dir = `${t.dir}/${folder}`;
    const descriptor = { ...(asset.assetId ? { assetId: asset.assetId } : {}), assetType: asset.assetType, metadata: this.descriptorMetadata(asset) };
    put(`${dir}/${this.rule.descriptor}`, Buffer.from(`${JSON.stringify(descriptor, null, 2)}\n`, "utf8"), asset);
    for (const f of asset.files) put(`${dir}/${f.path}`, bytesOf(f), asset);
    this.entries.push({
      dir,
      type: asset.assetType,
      name: asset.assetType === "agents_md" ? agentType : name,
      ...(asset.assetId ? { assetId: asset.assetId } : {}),
      ...(asset.metadata.status !== undefined ? { status: asset.metadata.status } : {}),
      files: asset.files.map((f) => f.path).sort(comparePaths),
    });
  }

  /** The folder index: the base package's index keys (other than assets) are kept. */
  index(): { path: string; data: Buffer } | null {
    const p = this.rule.index;
    if (!p) return null;
    let head: Record<string, unknown> = {};
    const baseIndex = this.base?.files.get(p);
    if (baseIndex) {
      try {
        const raw = JSON.parse(baseIndex.toString("utf8")) as unknown;
        if (raw && typeof raw === "object" && !Array.isArray(raw)) head = Object.fromEntries(Object.entries(raw as Record<string, unknown>).filter(([k]) => k !== "assets"));
      } catch {
        head = {};
      }
    }
    const order = Object.keys(this.rule.types);
    const assets = [...this.entries].sort((a, b) => order.indexOf(a.type) - order.indexOf(b.type) || comparePaths(a.dir, b.dir));
    return { path: p, data: Buffer.from(`${JSON.stringify({ ...head, assets }, null, 2)}\n`, "utf8") };
  }

  /** Metadata with every reference as asset IDs: name references resolve to the IDs of desired assets with that identity. */
  private descriptorMetadata(asset: DesiredAsset): Record<string, unknown> {
    const metadata: Record<string, unknown> = { ...asset.metadata };
    const entry = this.policy.assetTypes.assetTypes[asset.assetType];
    for (const rule of entry?.references ?? []) {
      const named = asset.refs?.[rule.ref];
      if (named === undefined || metadata[rule.key] !== undefined) continue;
      const names = Array.isArray(named) ? named : [named];
      const ids: string[] = [];
      for (const n of names) {
        const id = this.idByIdentity.get(`${rule.assetType}\0${n}`);
        if (id) ids.push(id);
        else {
          this.results.push(
            warning("export.reference-by-name", `${assetKeyOf(asset)} refers to ${n} (${rule.ref}), which has no asset ID yet, so the reference is not in its ${this.rule.descriptor}.`, { assetKey: assetKeyOf(asset) }),
          );
        }
      }
      if (ids.length) metadata[rule.key] = rule.many ? ids : ids[0];
    }
    return Object.fromEntries(Object.entries(metadata).filter(([, v]) => v !== undefined));
  }
}

/** One safe path segment. */
function isFolderName(s: string): boolean {
  return !!s && !s.includes("/") && pathProblem(s) === null;
}
