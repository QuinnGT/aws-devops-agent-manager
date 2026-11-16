import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { TRAILERS, type AssetJson, type ChangeSource } from "@/lib/assets/types";
import { resetEnvForTests } from "@/server/env";
import { HistoryRepo, type HistoryRepoConfig } from "@/server/git/history-repo";
import { assetDir, assetDisplayName } from "@/server/history/layout";
import { getAppPolicy, type Policy } from "@/server/policy";
import { apiFixture } from "../../../../test/helpers/fixtures";

/**
 * Test support: a history repository shaped like the sync worker writes it,
 * with assets and versions taken from test/fixtures/api/test-space. Only used
 * by tests (it commits, so it needs DAM_PROCESS=worker).
 */

export const TEST_ALIAS = "test-space";
export const SPACE_FIXTURE = { agentSpaceId: "00000000-0000-4000-8000-0000000000bb", region: "us-west-2", accountId: "111122223333" };

export const IDS = {
  agentsMd: "ki-8578b1bb-b5ff-41d8-9368-4f106b846352",
  skill: "ki-6e6624f9-cca2-4545-8c89-3519caa36a0f",
  store: "ki-63edd778-1a7a-483f-8b18-479742a15a04",
  overview: "ki-9184fa09-8e79-4a11-90fa-a6b81ab5fe6b",
  testingMcp: "ki-c64d7ddd-871f-47c9-9daa-9cd43d070728",
} as const;

export interface FixtureVersion {
  version: number;
  createdAt: string;
  updatedAt: string;
  metadata: Record<string, unknown>;
  files: Record<string, string>;
  /** Files listed in asset.json but not committed (above the size threshold) */
  uncommitted?: { path: string; size: number }[];
  changeKind: "created" | "content" | "metadata" | "deleted" | "baseline";
  source: ChangeSource;
  principal?: string;
}

export interface FixtureAsset {
  assetId: string;
  assetType: string;
  storeName?: string;
  parentAssetId?: string;
  versions: FixtureVersion[];
}

export interface FixtureCommit {
  assetId: string;
  assetType: string;
  version: number;
  updatedAt: string;
  changeKind: FixtureVersion["changeKind"];
  source: ChangeSource;
  principal: string | null;
  commit: string;
  gitPath: string;
}

export interface BuiltFixture {
  commits: FixtureCommit[];
  /** Directory per asset ID */
  gitPaths: Map<string, string>;
  /** Commits per asset ID, oldest first */
  byAsset: Map<string, FixtureCommit[]>;
}

function sha256(s: string): string {
  return createHash("sha256").update(s).digest("hex");
}

function text<T>(name: string, pick: (r: T) => string): string {
  return pick(apiFixture<T>(name).response);
}

type FileRes = { file: { content: { text: string } } };

/** The fixture assets: GENERIC instructions, a skill with references, a memory store and two of its memories. */
export function fixtureAssets(): FixtureAsset[] {
  const agentsMd = text<FileRes>("GetAssetFile.agents_md", (r) => r.file.content.text);
  const skillMd = text<FileRes>("GetAssetFile.skill", (r) => r.file.content.text);
  const overviewMd = text<FileRes>("GetAssetFile.memory", (r) => r.file.content.text);
  const storeMd = text<FileRes>("GetAssetFile.memory_store", (r) => r.file.content.text);
  const skillMeta = apiFixture<{ asset: { metadata: Record<string, unknown> } }>("GetAsset.skill").response.asset.metadata;
  const skillOld = apiFixture<{ asset: { metadata: Record<string, unknown> } }>("GetAsset.skill.oldVersion").response.asset.metadata;
  const overviewMeta = apiFixture<{ asset: { metadata: Record<string, unknown> } }>("GetAsset.memory").response.asset.metadata;
  const overviewOld = apiFixture<{ asset: { metadata: Record<string, unknown> } }>("GetAsset.memory.oldVersion").response.asset.metadata;
  const storeMeta = { name: "chat-tool-use-best-practices", agent_types: ["GENERIC"], status: "ACTIVE", description: "Chat tool-use best practices" };
  const refs = ["references/cross-region-privatelink-setup.md", "references/mcp-server-testing.md"];
  return [
    {
      assetId: IDS.agentsMd,
      assetType: "agents_md",
      versions: [
        {
          version: 4,
          createdAt: "2026-07-08T20:38:48.000Z",
          updatedAt: "2026-07-08T21:45:34.000Z",
          metadata: { status: "ACTIVE", agent_type: "GENERIC" },
          files: { "AGENTS.md": "# Verity Verification Requirements\n\nShort first draft.\n" },
          changeKind: "baseline",
          source: "unknown",
        },
        {
          version: 5,
          createdAt: "2026-07-08T20:38:48.000Z",
          updatedAt: "2026-08-05T20:39:44.000Z",
          metadata: { status: "ACTIVE", agent_type: "GENERIC" },
          files: { "AGENTS.md": agentsMd },
          changeKind: "content",
          source: "console",
          principal: "DevOpsAgentRole-WebappAdmin-abc/dam-alex-Admin",
        },
      ],
    },
    {
      assetId: IDS.skill,
      assetType: "skill",
      versions: [
        {
          version: 13,
          createdAt: "2026-07-07T18:43:41.000Z",
          updatedAt: "2026-09-16T18:42:23.000Z",
          metadata: skillOld,
          files: { "SKILL.md": "---\nname: chat-tool-use-best-practices\ndescription: old\n---\nOld body\n", [refs[0]!]: "setup v1\n" },
          changeKind: "baseline",
          source: "agent",
        },
        {
          version: 14,
          createdAt: "2026-07-07T18:43:41.000Z",
          updatedAt: "2026-09-26T18:42:37.000Z",
          metadata: skillMeta,
          files: { "SKILL.md": skillMd, [refs[0]!]: "setup v2\nmore\n", [refs[1]!]: "testing\n" },
          uncommitted: [{ path: "assets/diagram.png", size: 9_000_000 }],
          changeKind: "content",
          source: "agent",
        },
      ],
    },
    {
      assetId: IDS.store,
      assetType: "memory_store",
      versions: [
        {
          version: 10,
          createdAt: "2026-07-07T18:43:41.000Z",
          updatedAt: "2026-08-10T18:37:45.000Z",
          metadata: storeMeta,
          files: { "chat-tool-use-best-practices.md": storeMd },
          changeKind: "baseline",
          source: "agent",
        },
      ],
    },
    {
      assetId: IDS.overview,
      assetType: "memory",
      storeName: "chat-tool-use-best-practices",
      parentAssetId: IDS.store,
      versions: [
        {
          version: 23,
          createdAt: "2026-08-13T18:37:05.000Z",
          updatedAt: "2026-11-03T18:38:34.000Z",
          metadata: overviewOld,
          files: { "overview.md": "---\nname: overview\n---\nVersion 23 body\n" },
          changeKind: "baseline",
          source: "agent",
        },
        {
          version: 24,
          createdAt: "2026-08-13T18:37:05.000Z",
          updatedAt: "2026-11-07T18:33:31.000Z",
          metadata: overviewMeta,
          files: { "overview.md": overviewMd },
          changeKind: "content",
          source: "agent",
        },
        {
          version: 24,
          createdAt: "2026-08-13T18:37:05.000Z",
          updatedAt: "2026-11-10T23:30:02.000Z",
          metadata: { ...overviewMeta, status: "INACTIVE" },
          files: { "overview.md": overviewMd },
          changeKind: "metadata",
          source: "console",
          principal: "DevOpsAgentRole-WebappAdmin-abc/dam-alex-Admin",
        },
        {
          version: 24,
          createdAt: "2026-08-13T18:37:05.000Z",
          updatedAt: "2026-11-10T23:38:13.000Z",
          metadata: { ...overviewMeta, status: "ACTIVE" },
          files: { "overview.md": overviewMd },
          changeKind: "metadata",
          source: "console",
          principal: "DevOpsAgentRole-WebappAdmin-abc/dam-alex-Admin",
        },
      ],
    },
    {
      assetId: IDS.testingMcp,
      assetType: "memory",
      storeName: "chat-tool-use-best-practices",
      parentAssetId: IDS.store,
      versions: [
        {
          version: 2,
          createdAt: "2026-08-13T18:37:05.000Z",
          updatedAt: "2026-11-07T18:33:33.000Z",
          metadata: { name: "categories/testing-mcp-servers", status: "ACTIVE", memory_store_id: IDS.store },
          files: { "testing-mcp-servers.md": "# Testing MCP servers\n" },
          changeKind: "baseline",
          source: "agent",
        },
      ],
    },
  ];
}

export function fixtureRepoConfig(name = "test-space-history"): HistoryRepoConfig {
  return { id: "00000000-0000-4000-8000-000000000001", name, remoteUrl: null, deployKeyFile: null, defaultBranch: "main", pushEnabled: false };
}

/** Write one commit per version, in time order across assets, the way the sync worker does. */
export async function buildHistoryFixture(repo: HistoryRepo, assets: FixtureAsset[], layout: Policy["historyLayout"] = getAppPolicy().policy.historyLayout): Promise<BuiltFixture> {
  const events = assets.flatMap((a) => a.versions.map((v) => ({ a, v }))).sort((x, y) => Date.parse(x.v.updatedAt) - Date.parse(y.v.updatedAt));
  const committer = getAppPolicy().policy.sync.committer;
  const commits: FixtureCommit[] = [];
  const gitPaths = new Map<string, string>();
  for (const { a, v } of events) {
    const dir = assetDir(layout, TEST_ALIAS, { assetId: a.assetId, assetType: a.assetType, metadata: v.metadata, storeName: a.storeName ?? null });
    gitPaths.set(a.assetId, dir);
    const assetJson: AssetJson = {
      assetId: a.assetId,
      assetType: a.assetType,
      metadata: v.metadata,
      serviceVersion: v.version,
      serviceCreatedAt: v.createdAt,
      serviceUpdatedAt: v.updatedAt,
      files: [
        ...Object.entries(v.files).map(([p, c]) => ({ path: p, sha256: sha256(c), size: Buffer.byteLength(c), committed: true, mimeType: "text/markdown" })),
        ...(v.uncommitted ?? []).map((u) => ({ path: u.path, sha256: sha256(u.path), size: u.size, committed: false, mimeType: "image/png" })),
      ],
    };
    const prev = commits.filter((c) => c.assetId === a.assetId).at(-1);
    const prevFiles = prev ? assets.find((x) => x.assetId === a.assetId)!.versions.find((x) => x.version === prev.version && x.updatedAt === prev.updatedAt)!.files : {};
    const removed = Object.keys(prevFiles).filter((p) => !(p in v.files));
    const name = assetDisplayName(layout, { assetId: a.assetId, assetType: a.assetType, metadata: v.metadata });
    const hash = await repo.writeAndCommit(
      [
        { path: path.posix.join(dir, layout.assetJson), content: `${JSON.stringify(assetJson, null, 2)}\n` },
        ...Object.entries(v.files).map(([p, c]) => ({ path: path.posix.join(dir, p), content: c })),
        ...removed.map((p) => ({ path: path.posix.join(dir, p), content: null })),
      ],
      {
        message: `${a.assetType} ${name}: version ${v.version} (${v.changeKind})`,
        author: { name: v.principal ?? "DevOps Agent", email: "agent@devops-agent.invalid" },
        committer,
        date: new Date(v.updatedAt),
        trailers: {
          [TRAILERS.assetId]: a.assetId,
          [TRAILERS.assetType]: a.assetType,
          [TRAILERS.serviceVersion]: v.version,
          [TRAILERS.serviceUpdatedAt]: v.updatedAt,
          [TRAILERS.changeSource]: v.source,
          [TRAILERS.principal]: v.principal,
          [TRAILERS.spaceAlias]: TEST_ALIAS,
        },
      },
    );
    if (!hash) throw new Error(`fixture commit for ${a.assetId} v${v.version} made no change`);
    commits.push({
      assetId: a.assetId,
      assetType: a.assetType,
      version: v.version,
      updatedAt: v.updatedAt,
      changeKind: v.changeKind,
      source: v.source,
      principal: v.principal ?? null,
      commit: hash,
      gitPath: dir,
    });
  }
  const byAsset = new Map<string, FixtureCommit[]>();
  for (const c of commits) byAsset.set(c.assetId, [...(byAsset.get(c.assetId) ?? []), c]);
  return { commits, gitPaths, byAsset };
}

/** Point DAM_DATA_DIR at a fresh temp dir and run as the worker. Returns a cleanup function. */
export async function useTempDataDir(): Promise<{ dir: string; cleanup: () => Promise<void> }> {
  const saved = { dataDir: process.env.DAM_DATA_DIR, proc: process.env.DAM_PROCESS };
  const dir = await mkdtemp(path.join(os.tmpdir(), "dam-assets-"));
  process.env.DAM_DATA_DIR = dir;
  process.env.DAM_PROCESS = "worker";
  resetEnvForTests();
  return {
    dir,
    cleanup: async () => {
      if (saved.dataDir === undefined) delete process.env.DAM_DATA_DIR;
      else process.env.DAM_DATA_DIR = saved.dataDir;
      if (saved.proc === undefined) delete process.env.DAM_PROCESS;
      else process.env.DAM_PROCESS = saved.proc;
      resetEnvForTests();
      await rm(dir, { recursive: true, force: true });
    },
  };
}
