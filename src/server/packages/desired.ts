import { getAppPolicy, type Policy } from "@/server/policy";
import type { AssetFoldersRule } from "@/server/policy/sections/package-layouts";
import { assetIdentity } from "@/server/validation/identity";
import { error, warning, type ValidationResult } from "@/server/validation/types";
import { assetMainFile, listAssetFolders, matchesKeep, parseDescriptor, uploadedFiles, type AssetFolder } from "./asset-folders";
import { parseFrontmatter, yamlAt, yamlSentence } from "./frontmatter";
import { agentTypeResolver, getLayout, isNonAsset, parseAgentTypes, sharedSections, type PackageLayout } from "./layout";
import { manifestMetadata, parseManifest, type PackageManifest } from "./manifest";
import { basename, fill, sortPaths } from "./paths";
import { decodeText } from "./text";
import { assetKeyOf, type DesiredAsset, type DesiredFile, type PackageContents, type PackageFile } from "./types";
import { readZip } from "./zip";

/**
 * Map a package to desired assets with the layout's rules. Every package file
 * gets a role; files that no rule claims are reported as warnings.
 */

export type FileRole = "asset" | "build-artifact" | "manifest" | "non-asset" | "skipped" | "unmapped";

export interface MappedPackage {
  assets: DesiredAsset[];
  /** Problems found while mapping (unmapped files, bad frontmatter, unknown agent types) */
  results: ValidationResult[];
  /** Role of every package file, and the asset it belongs to */
  roles: Map<string, { role: FileRole; assetKey?: string }>;
}

export interface MapOptions {
  /** Defaults to getAppPolicy().policy */
  policy?: Policy;
}

type MapPolicy = Pick<Policy, "assetTypes" | "agentTypes" | "limits">;

export function packageToDesiredAssets(contents: PackageContents, layoutOrName?: PackageLayout | string, opts: MapOptions = {}): MappedPackage {
  const policy = opts.policy ?? getAppPolicy().policy;
  const layout = typeof layoutOrName === "object" ? layoutOrName : getLayout(policy, layoutOrName);
  const ctx = new Mapper(contents, layout, policy);
  ctx.run();
  return { assets: ctx.sortedAssets(), results: ctx.results, roles: ctx.roles };
}

/**
 * Every UTF-8 file of every asset in the package, with its package path and
 * the text that is uploaded (for memory stores, the STORE.md body).
 */
export function packageToPackageFiles(contents: PackageContents, layoutOrName?: PackageLayout | string, opts: MapOptions = {}): PackageFile[] {
  const { assets } = packageToDesiredAssets(contents, layoutOrName, opts);
  return assets.flatMap((a) =>
    a.files
      .filter((f) => f.encoding === "utf8")
      .map((f) => ({ assetType: a.assetType, name: a.key, path: f.sourcePath ?? `${a.source ?? a.key}/${f.path}`, body: f.content })),
  );
}

class Mapper {
  readonly results: ValidationResult[] = [];
  readonly roles = new Map<string, { role: FileRole; assetKey?: string }>();
  private readonly assets: DesiredAsset[] = [];
  private readonly resolveAgentType: (t: string) => string | null;
  private manifest: PackageManifest | null = null;

  constructor(
    private readonly contents: PackageContents,
    private readonly layout: PackageLayout,
    private readonly policy: MapPolicy,
  ) {
    this.resolveAgentType = agentTypeResolver(policy, layout);
  }

  run(): void {
    this.readManifest();
    this.mapInstructions();
    this.mapSkills();
    this.mapAssetFolders();
    this.mapMemory();
    this.mapCustomAgents();
    for (const s of sharedSections(this.layout)) if (this.contents.files.has(s.source)) this.claim(s.source, "non-asset");
    for (const p of this.contents.files.keys()) {
      if (this.roles.has(p)) continue;
      if (isNonAsset(this.layout, p)) this.claim(p, "non-asset");
      else {
        this.claim(p, "unmapped");
        this.results.push(warning("package.unmapped-file", `${p} doesn't match any asset in the ${this.layout.label} layout, so it won't be uploaded.`, { path: p }));
      }
    }
  }

  sortedAssets(): DesiredAsset[] {
    const order = Object.keys(this.policy.assetTypes.assetTypes);
    return [...this.assets].sort((a, b) => order.indexOf(a.assetType) - order.indexOf(b.assetType) || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  }

  private claim(path: string, role: FileRole, assetKey?: string): void {
    this.roles.set(path, assetKey ? { role, assetKey } : { role });
  }

  private text(path: string): string | null {
    const t = decodeText(this.contents.files.get(path)!);
    if (t === null) this.results.push(error("package.not-text", `${path} must be UTF-8 text.`, { path }));
    return t;
  }

  private file(path: string, assetPath: string): DesiredFile {
    const bytes = this.contents.files.get(path)!;
    const t = decodeText(bytes);
    return t === null
      ? { path: assetPath, encoding: "base64", content: bytes.toString("base64"), sourcePath: path }
      : { path: assetPath, encoding: "utf8", content: t, sourcePath: path };
  }

  private add(asset: Omit<DesiredAsset, "key">, paths: string[], key?: string): DesiredAsset {
    const full: DesiredAsset = { ...asset, key: key ?? assetIdentity(this.policy, asset) };
    this.assets.push(full);
    for (const p of paths) this.claim(p, "asset", assetKeyOf(full));
    return full;
  }

  private overlayManifest(assetType: string, key: string, metadata: Record<string, unknown>): void {
    for (const [k, v] of Object.entries(manifestMetadata(this.manifest, assetType, key))) if (metadata[k] === undefined) metadata[k] = v;
  }

  private agentTypes(value: unknown, path: string): string[] | undefined {
    const parsed = parseAgentTypes(value, this.resolveAgentType);
    if (!parsed) return undefined;
    for (const u of parsed.unknown) {
      this.results.push(error("package.agent-type-unknown", `${path} names agent type ${JSON.stringify(u)}, which is not in agent-types.yaml or the layout's agentTypeNames.`, { path }));
    }
    return parsed.ids;
  }

  private readManifest(): void {
    const p = this.layout.manifest;
    if (!p || !this.contents.files.has(p)) return;
    this.claim(p, "manifest");
    const t = this.text(p);
    if (t === null) return;
    const { manifest, error: problem } = parseManifest(t);
    if (problem) this.results.push(error("package.manifest-invalid", `${p} is not a valid package manifest: ${problem}`, { path: p }));
    this.manifest = manifest;
  }

  private mapInstructions(): void {
    const rule = this.layout.instructions;
    if (!rule) return;
    const mainFile = this.policy.assetTypes.assetTypes.agents_md?.mainFile ?? "AGENTS.md";
    for (const p of this.contents.files.keys()) {
      if (!p.startsWith(`${rule.dir}/`) || p.slice(rule.dir.length + 1).includes("/")) continue;
      const name = basename(p);
      if (!(name in rule.files)) continue;
      const agentType = rule.files[name];
      if (agentType === null || agentType === undefined) {
        this.claim(p, "skipped");
        this.results.push(warning("package.no-agent-type", `${p} has no documented agent_type value, so it is not imported. Load it on the Agents page by hand.`, { path: p }));
        continue;
      }
      if (this.text(p) === null) continue;
      const metadata: Record<string, unknown> = { agent_type: agentType };
      this.overlayManifest("agents_md", agentType, metadata);
      this.add({ assetType: "agents_md", metadata, files: [this.file(p, mainFile)], source: p }, [p]);
    }
  }

  private mapSkills(): void {
    const rule = this.layout.skills;
    if (!rule) return;
    const prefix = `${rule.dir}/`;
    const folders = new Set<string>();
    const zips: string[] = [];
    for (const p of this.contents.files.keys()) {
      if (!p.startsWith(prefix)) continue;
      const rest = p.slice(prefix.length);
      if (rest.includes("/")) folders.add(rest.slice(0, rest.indexOf("/")));
      else if (rule.archive && rest.endsWith(".zip")) zips.push(p);
    }
    for (const name of sortPaths(folders)) {
      const dir = `${prefix}${name}`;
      const main = `${dir}/${rule.mainFile}`;
      const paths = sortPaths([...this.contents.files.keys()].filter((p) => p.startsWith(`${dir}/`)));
      if (!this.contents.files.has(main)) continue; // reported as unmapped files
      this.addSkill(name, dir, paths.map((p) => ({ source: p, path: p.slice(dir.length + 1), bytes: this.contents.files.get(p)! })));
      if (rule.archive) {
        const zip = `${prefix}${fill(rule.archive, { name })}`;
        if (this.contents.files.has(zip)) this.claim(zip, "build-artifact");
      }
    }
    // A skill shipped only as a zip: read it with the same safety rules as uploads.
    for (const zip of zips) {
      if (this.roles.has(zip)) continue;
      const name = basename(zip).replace(/\.zip$/, "");
      if (rule.archive && fill(rule.archive, { name }) !== basename(zip)) continue;
      const { entries, problems } = readZip(this.contents.files.get(zip)!, this.policy.limits.packageRead, zip);
      if (problems.length) {
        this.claim(zip, "skipped");
        this.results.push(...problems.map((p) => ({ ...p, path: zip })));
        continue;
      }
      const files = entries.filter((e) => !e.isDirectory && e.name.startsWith(`${name}/`)).map((e) => ({ source: zip, path: e.name.slice(name.length + 1), bytes: e.data }));
      if (!files.some((f) => f.path === rule.mainFile)) {
        this.claim(zip, "unmapped");
        this.results.push(warning("package.unmapped-file", `${zip} has no ${name}/${rule.mainFile}, so it is not a skill.`, { path: zip }));
        continue;
      }
      this.addSkill(name, zip, files);
    }
  }

  private addSkill(folderName: string, source: string, files: { source: string; path: string; bytes: Buffer }[]): void {
    const rule = this.layout.skills!;
    const mainFile = files.find((f) => f.path === rule.mainFile)!;
    const mainText = decodeText(mainFile.bytes);
    const metadata: Record<string, unknown> = {};
    if (mainText === null) {
      this.results.push(error("package.not-text", `${mainFile.source} must be UTF-8 text.`, { path: mainFile.source }));
    } else {
      const fm = parseFrontmatter(mainText);
      if (fm.error) this.results.push(error("package.frontmatter-invalid", yamlSentence(`${source}/${rule.mainFile}`, fm), { path: mainFile.source, ...yamlAt(fm) }));
      for (const [metaKey, fmKey] of Object.entries(rule.frontmatter)) {
        const v = fm.data?.[fmKey];
        if (v === undefined || v === null) continue;
        metadata[metaKey] = metaKey === "agent_types" ? this.agentTypes(v, mainFile.source) : v;
      }
    }
    if (metadata.name === undefined) metadata.name = folderName;
    this.overlayManifest("skill", String(metadata.name), metadata);
    if (metadata.agent_types === undefined) {
      const types = rule.agentTypes.bySkill[String(metadata.name)] ?? rule.agentTypes.default;
      if (types.length) metadata.agent_types = [...types];
    }
    const desiredFiles: DesiredFile[] = files.map((f) => {
      const t = decodeText(f.bytes);
      const sourcePath = f.source === source && source.endsWith(".zip") ? `${source}#${folderName}/${f.path}` : f.source;
      return t === null ? { path: f.path, encoding: "base64", content: f.bytes.toString("base64"), sourcePath } : { path: f.path, encoding: "utf8", content: t, sourcePath };
    });
    this.add({ assetType: "skill", metadata, files: desiredFiles, source }, [...new Set(files.map((f) => f.source))]);
  }

  /**
   * Agent Space folders: each `<type dir>/<folder>/` with a descriptor is one
   * asset. Its type and metadata come from the descriptor (bookkeeping keys
   * dropped), its files are every other file of the folder, byte for byte,
   * and the descriptor's assetId becomes sourceAssetId. Several assets with
   * one identity (the space allows two skills with one name) keep distinct
   * keys: the one the layout's `duplicates.keep` prefers keeps the identity,
   * the others get `<identity>@<source asset ID>`.
   */
  private mapAssetFolders(): void {
    const rule = this.layout.assetFolders;
    if (!rule) return;
    type Pending = { asset: Omit<DesiredAsset, "key">; identity: string; paths: string[]; folder: AssetFolder };
    const pending: Pending[] = [];
    const described: { dir: string; assetId?: string }[] = [];
    const folders = listAssetFolders(this.contents.files.keys(), rule);
    for (const f of folders) {
      if (!f.hasDescriptor) {
        for (const p of f.files) this.claim(p, "unmapped");
        this.results.push(warning("package.descriptor-missing", `${f.dir}/ has no ${rule.descriptor}, so it is not imported.`, { path: f.dir }));
        continue;
      }
      this.claim(f.descriptorPath, "manifest");
      const { descriptor, problem } = parseDescriptor(this.contents.files.get(f.descriptorPath)!, rule);
      described.push({ dir: f.dir, ...(descriptor?.assetId ? { assetId: descriptor.assetId } : {}) });
      const skip = (code: string, message: string) => {
        for (const p of f.files) this.claim(p, "skipped");
        this.results.push(error(code, message, { path: f.descriptorPath }));
      };
      if (!descriptor) {
        skip("package.descriptor-invalid", `${f.descriptorPath} is not a valid asset descriptor: ${problem}.`);
        continue;
      }
      if (descriptor.assetType !== undefined && descriptor.assetType !== f.assetType) {
        skip("package.descriptor-type", `${f.descriptorPath} says assetType ${descriptor.assetType}, but its folder is under ${rule.types[f.assetType]!.dir}/ (${f.assetType}).`);
        continue;
      }
      if (descriptor.extraKeys.length) {
        const keys = descriptor.extraKeys.join(", ");
        this.results.push(warning("package.descriptor-key", `${f.descriptorPath} has ${keys}, which ${descriptor.extraKeys.length === 1 ? "is" : "are"} not part of the asset and won't be uploaded.`, { path: f.descriptorPath }));
      }
      const { uploaded, never } = uploadedFiles(f, rule);
      for (const p of never) this.claim(p, "non-asset");
      const entry = this.policy.assetTypes.assetTypes[f.assetType];
      const main = assetMainFile(rule, f.assetType, descriptor.metadata, f.folder);
      const reportedByValidation = entry?.mainFileRequired && entry.mainFile === main;
      if (main && !uploaded.includes(`${f.dir}/${main}`) && !reportedByValidation) {
        this.results.push(error("package.main-file-missing", `${f.dir}/ has no ${main}.`, { path: f.dir }));
      }
      const asset: Omit<DesiredAsset, "key"> = {
        assetType: f.assetType,
        metadata: descriptor.metadata,
        files: uploaded.map((p) => this.file(p, p.slice(f.dir.length + 1))),
        source: f.dir,
        ...(descriptor.assetId ? { sourceAssetId: descriptor.assetId } : {}),
      };
      pending.push({ asset, identity: assetIdentity(this.policy, asset), paths: uploaded, folder: f });
    }

    const byId = new Map<string, Pending[]>();
    for (const p of pending) if (p.asset.sourceAssetId) byId.set(p.asset.sourceAssetId, [...(byId.get(p.asset.sourceAssetId) ?? []), p]);
    for (const [id, group] of byId) {
      if (group.length < 2) continue;
      for (const p of group) {
        const others = group.filter((o) => o !== p).map((o) => `${o.folder.dir}/`);
        this.results.push(error("package.duplicate-asset-id", `${p.folder.descriptorPath} has assetId ${id}, like ${joinWords(others)}. Each folder must be a different asset.`, { path: p.folder.descriptorPath }));
      }
    }

    const groups = new Map<string, Pending[]>();
    for (const p of pending) groups.set(`${p.asset.assetType}\0${p.identity}`, [...(groups.get(`${p.asset.assetType}\0${p.identity}`) ?? []), p]);
    const keys = new Map<Pending, string>();
    for (const group of groups.values()) {
      const ordered = [...group].sort((a, b) => Number(matchesKeep(b.asset.metadata, this.layout.duplicates)) - Number(matchesKeep(a.asset.metadata, this.layout.duplicates)));
      ordered.forEach((p, i) => keys.set(p, i === 0 ? p.identity : `${p.identity}@${p.asset.sourceAssetId ?? p.folder.folder}`));
    }
    for (const p of pending) this.add(p.asset, p.paths, keys.get(p));
    this.checkAssetIndex(rule, described);
  }

  /** The layout's folder index (INDEX.json): never uploaded; folders it misses or lists wrongly are warnings. */
  private checkAssetIndex(rule: AssetFoldersRule, folders: { dir: string; assetId?: string }[]): void {
    const p = rule.index;
    if (!p || !this.contents.files.has(p)) return;
    this.claim(p, "manifest");
    const t = decodeText(this.contents.files.get(p)!);
    let listed: { dir: string; assetId?: unknown }[] | null = null;
    try {
      const raw = t === null ? null : (JSON.parse(t) as { assets?: unknown });
      if (raw && Array.isArray(raw.assets)) listed = raw.assets.filter((a): a is { dir: string; assetId?: unknown } => typeof a === "object" && a !== null && typeof (a as { dir?: unknown }).dir === "string");
    } catch {
      listed = null;
    }
    if (!listed) {
      this.results.push(warning("package.index-invalid", `${p} is not a list of asset folders ({ "assets": [{ "dir": ... }] }), so it was not checked.`, { path: p }));
      return;
    }
    const byDir = new Map(listed.map((a) => [a.dir.replace(/\/+$/, ""), a]));
    for (const f of folders) {
      const e = byDir.get(f.dir);
      if (!e) this.results.push(warning("package.index-stale", `${p} doesn't list ${f.dir}/.`, { path: p }));
      else if (f.assetId && e.assetId !== undefined && e.assetId !== f.assetId) {
        this.results.push(warning("package.index-stale", `${p} gives ${f.dir}/ the asset ID ${String(e.assetId)}, but its ${rule.descriptor} says ${f.assetId}.`, { path: p }));
      }
    }
    const present = new Set(folders.map((f) => f.dir));
    for (const dir of byDir.keys()) {
      if (!present.has(dir)) this.results.push(warning("package.index-stale", `${p} lists ${dir}/, which is not an asset folder in the package.`, { path: p }));
    }
  }

  private mapMemory(): void {
    const rule = this.layout.memory;
    if (!rule) return;
    const prefix = `${rule.dir}/`;
    const stores = new Set<string>();
    for (const p of this.contents.files.keys()) {
      if (!p.startsWith(prefix)) continue;
      const rest = p.slice(prefix.length);
      if (rest.includes("/")) stores.add(rest.slice(0, rest.indexOf("/")));
    }
    for (const folder of sortPaths(stores)) {
      const dir = `${prefix}${folder}`;
      const storePath = `${dir}/${rule.storeFile}`;
      let storeName = folder;
      if (this.contents.files.has(storePath)) {
        const t = this.text(storePath);
        if (t !== null) {
          const fm = parseFrontmatter(t);
          if (fm.error) this.results.push(error("package.frontmatter-invalid", yamlSentence(`${storePath}`, fm), { path: storePath, ...yamlAt(fm) }));
          const metadata: Record<string, unknown> = {};
          for (const [metaKey, fmKey] of Object.entries(rule.storeFrontmatter)) {
            const v = fm.data?.[fmKey];
            if (v === undefined || v === null) continue;
            metadata[metaKey] = metaKey === "agent_types" ? this.agentTypes(v, storePath) : v;
          }
          if (typeof metadata.name !== "string" || !metadata.name) metadata.name = folder;
          else if (metadata.name !== folder) {
            this.results.push(warning("package.store-name-mismatch", `${storePath} names the store ${String(metadata.name)} but its folder is ${folder}.`, { path: storePath }));
          }
          storeName = String(metadata.name);
          this.overlayManifest("memory_store", storeName, metadata);
          const body = fm.body.replace(/^(?:\r?\n)+/, "");
          const sourceAssetId = rule.storeAssetIdKey ? fm.data?.[rule.storeAssetIdKey] : undefined;
          this.add(
            {
              assetType: "memory_store",
              metadata,
              files: [{ path: rule.storeContentFile, encoding: "utf8", content: body, sourcePath: storePath }],
              source: storePath,
              ...(typeof sourceAssetId === "string" && sourceAssetId ? { sourceAssetId } : {}),
            },
            [storePath],
          );
        }
      }
      if (rule.indexFile && this.contents.files.has(`${dir}/${rule.indexFile}`)) this.claim(`${dir}/${rule.indexFile}`, "build-artifact");
      for (const p of sortPaths([...this.contents.files.keys()].filter((x) => x.startsWith(`${dir}/`)))) {
        if (this.roles.has(p) || !p.endsWith(".md") || basename(p) === rule.storeFile || basename(p) === rule.indexFile) continue;
        const t = this.text(p);
        if (t === null) continue;
        const fm = parseFrontmatter(t);
        if (fm.error) this.results.push(error("package.frontmatter-invalid", yamlSentence(`${p}`, fm), { path: p, ...yamlAt(fm) }));
        const metadata: Record<string, unknown> = {};
        for (const [metaKey, fmKey] of Object.entries(rule.memoryFrontmatter)) {
          const v = fm.data?.[fmKey];
          if (v !== undefined && v !== null) metadata[metaKey] = v;
        }
        const rel = p.slice(dir.length + 1);
        if (typeof metadata.name !== "string" || !metadata.name) metadata.name = rel.replace(/\.md$/, "");
        const name = String(metadata.name);
        this.overlayManifest("memory", `${storeName}/${name}`, metadata);
        const filePath = fill(rule.memoryFile, { basename: basename(name), name, stem: basename(rel).replace(/\.md$/, "") });
        this.add({ assetType: "memory", metadata, refs: { memoryStore: storeName }, files: [{ path: filePath, encoding: "utf8", content: t, sourcePath: p }], source: p }, [p]);
      }
    }
  }

  private mapCustomAgents(): void {
    const rule = this.layout.customAgents;
    if (!rule) return;
    const prefix = `${rule.dir}/`;
    const folders = new Set<string>();
    for (const p of this.contents.files.keys()) {
      if (p.startsWith(prefix) && p.slice(prefix.length).includes("/")) folders.add(p.slice(prefix.length).split("/")[0]!);
    }
    for (const folder of sortPaths(folders)) {
      const dir = `${prefix}${folder}`;
      const main = `${dir}/${rule.mainFile}`;
      if (!this.contents.files.has(main)) continue;
      const t = this.text(main);
      if (t === null) continue;
      const fm = parseFrontmatter(t);
      if (fm.error) this.results.push(error("package.frontmatter-invalid", yamlSentence(`${main}`, fm), { path: main, ...yamlAt(fm) }));
      const metadata: Record<string, unknown> = {};
      for (const [metaKey, fmKey] of Object.entries(rule.frontmatter)) {
        const v = fm.data?.[fmKey];
        if (v !== undefined && v !== null) metadata[metaKey] = v;
      }
      if (typeof metadata.name !== "string" || !metadata.name) metadata.name = folder;
      const refs: Record<string, string[]> = {};
      for (const [refName, fmKey] of Object.entries(rule.refs)) {
        const v = fm.data?.[fmKey];
        if (Array.isArray(v)) refs[refName] = v.map(String);
        else if (typeof v === "string") refs[refName] = v.split(",").map((s) => s.trim()).filter(Boolean);
      }
      this.overlayManifest("custom_agent", String(metadata.name), metadata);
      const paths = sortPaths([...this.contents.files.keys()].filter((p) => p.startsWith(`${dir}/`)));
      const files = paths.map((p) =>
        p === main ? { path: rule.mainFile, encoding: "utf8" as const, content: fm.body.replace(/^(?:\r?\n)+/, ""), sourcePath: p } : this.file(p, p.slice(dir.length + 1)),
      );
      this.add({ assetType: "custom_agent", metadata, refs, files, source: dir }, paths);
    }
  }
}

/** "a", "a and b", "a, b and c". */
function joinWords(items: readonly string[]): string {
  return items.length <= 1 ? (items[0] ?? "") : `${items.slice(0, -1).join(", ")} and ${items.at(-1)}`;
}
