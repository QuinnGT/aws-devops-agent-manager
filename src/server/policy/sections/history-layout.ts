import { z } from "zod";
import { defineSection } from "./define";

/**
 * Path templates for the history repository. Placeholders:
 *   {spaceAlias} {assetType} {assetId} {name} {agentType} {storeName}
 *   {release} {auditId} {package}
 * {name} and {storeName} are path-safe forms of metadata names; a memory name
 * such as "databases/rds-failover" keeps its slashes.
 */
export const historyLayoutSection = defineSection(
  "history-layout.yaml",
  z.object({
    spaceRoot: z.string().default("spaces/{spaceAlias}"),
    spaceFile: z.string().default("space.json"),
    assetJson: z.string().default("asset.json"),
    /** Asset directory per asset type, relative to spaceRoot. `default` covers unknown types. */
    assetDirs: z.record(z.string(), z.string()).refine((m) => "default" in m, "assetDirs.default is required"),
    /** Metadata key holding the display name, per asset type, falling back to `default` */
    nameKeys: z.record(z.string(), z.string()).default({ default: "name", agents_md: "agent_type" }),
    releaseManifest: z.string().default("releases/{spaceAlias}/{release}.json"),
    auditDir: z.string().default("audits/{spaceAlias}/{auditId}"),
    packageDir: z.string().default("packages/{spaceAlias}/{package}"),
    policyDir: z.string().default("policy"),
    /** Git notes ref for change reasons added after the fact */
    notesRef: z.string().default("refs/notes/devops-agent"),
    /** Tag name template for releases */
    releaseTag: z.string().default("{spaceAlias}/{release}"),
    /** Revision branch template */
    revisionBranch: z.string().default("revision/{spaceAlias}/{name}"),
    /** Files larger than this are not committed (attachments); their hash is kept in asset.json */
    maxCommittedFileBytes: z.number().int().positive().default(5 * 1024 * 1024),
  }),
);
