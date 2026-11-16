import { z } from "zod";
import { defineSection } from "./define";

/**
 * Release names, release commits and tags, and the
 * rollback planner's rules. policy/releases.yaml documents each key.
 */

/** What a rollback does with an asset that was added after the target. */
export const addedAfterActionSchema = z.enum(["deactivate", "keep", "delete"]);
export type AddedAfterAction = z.output<typeof addedAfterActionSchema>;

const nameDefault = {
  pattern: "^[A-Za-z0-9](?:[A-Za-z0-9._-]{0,62}[A-Za-z0-9])?$",
  hint: "Use 1 to 64 letters, numbers, dots, hyphens and underscores, starting and ending with a letter or number, for example v2.3.",
  maxLength: 64,
  uniqueIgnoringCase: true,
};

const committerDefault = { name: "DevOps Agent Manager", email: "releases@devops-agent-manager.invalid" };

const titlesDefault = {
  release: "Restore {spaceAlias} to release {release}",
  commit: "Restore {spaceAlias} to commit {shortCommit}",
  version: "Restore {assetName} to v{version}",
};

const notesDefault = {
  recreated: "Deleted since the target: created again, with a new asset ID.",
  replaced: "Replaced since the target by an asset with the same name: this updates the new asset.",
  deactivated: "Added after the target: set Inactive instead of deleting.",
  deleted: "Added after the target: deleted.",
  kept: "Added after the target and left as it is.",
  alreadyInactive: "Added after the target and already Inactive, so it is left as it is.",
  removedKeys: "Removes metadata keys added after the target: {keys}.",
  fetched: "Files read from the service because the history repository doesn't hold them: {paths}.",
  managed: "The DevOps Agent maintains memories in managed stores, so a release restore leaves it as it is. To go back to an older version, restore it from its Versions tab.",
  notEditable: "Not editable through the app, so a restore leaves it as it is.",
};

const rollbackDefault = {
  addedAfterTarget: { skill: "deactivate" as const, default: "keep" as const },
  managed: "skip" as const,
  keepMetadataKeys: ["skill_type", "memory_store_id"],
  statusKey: "status",
  inactiveValue: "INACTIVE",
  titles: titlesDefault,
  notes: notesDefault,
};

function compiles(pattern: string): boolean {
  try {
    new RegExp(pattern);
    return true;
  } catch {
    return false;
  }
}

export const releasesSection = defineSection(
  "releases.yaml",
  z.object({
    name: z
      .object({
        /** Regex a release name must match. The name becomes part of a git tag and a file name. */
        pattern: z.string().refine(compiles, "not a valid regular expression").default(nameDefault.pattern),
        /** Message shown when a name doesn't match the pattern */
        hint: z.string().default(nameDefault.hint),
        maxLength: z.number().int().min(1).max(200).default(nameDefault.maxLength),
        /** Treat names that differ only in case as duplicates (tags and files collide on case-insensitive file systems) */
        uniqueIgnoringCase: z.boolean().default(nameDefault.uniqueIgnoringCase),
      })
      .default(nameDefault),
    /** Longest release note accepted */
    noteMaxChars: z.number().int().min(0).default(2000),
    /** Run an incremental sync before a release built from HEAD; a release of a given commit never syncs */
    syncBeforeCreate: z.boolean().default(true),
    /** Subject of the commit that adds the manifest. Placeholders: {release} {spaceAlias} {shortCommit} */
    commitMessage: z.string().default("Release {release} of {spaceAlias}"),
    /** Annotated tag message. Same placeholders. */
    tagMessage: z.string().default("Release {release} of {spaceAlias} (assets as of {shortCommit})"),
    /** Committer of release commits and tags; the author is the user who created the release */
    committer: z.object({ name: z.string().min(1), email: z.string().min(1) }).default(committerDefault),
    rollback: z
      .object({
        /**
         * Per asset type (and `default`): what a rollback of a release or commit
         * does with an asset added after the target. deactivate sets the status
         * key to inactiveValue (types without supportsStatus fall back to keep),
         * keep leaves it and lists it, delete adds it to the plan's deletes
         * (refused unless the space allows deletes).
         */
        addedAfterTarget: z.record(z.string(), addedAfterActionSchema).default(rollbackDefault.addedAfterTarget),
        /** Managed memory stores and their memories: skip them, or include them like any other asset */
        managed: z.enum(["skip", "include"]).default(rollbackDefault.managed),
        /** Metadata keys a rollback never removes, even when the target doesn't have them */
        keepMetadataKeys: z.array(z.string()).default(rollbackDefault.keepMetadataKeys),
        /** Metadata key and value that make an asset Inactive */
        statusKey: z.string().default(rollbackDefault.statusKey),
        inactiveValue: z.string().default(rollbackDefault.inactiveValue),
        /** Plan titles. Placeholders: {spaceAlias} {release} {shortCommit} {assetName} {assetType} {version} */
        titles: z
          .object({
            release: z.string().default(titlesDefault.release),
            commit: z.string().default(titlesDefault.commit),
            version: z.string().default(titlesDefault.version),
          })
          .default(titlesDefault),
        /** Notes shown on plan items and in the rollback preview. {keys} and {paths} are comma-separated lists. */
        notes: z
          .object({
            recreated: z.string().default(notesDefault.recreated),
            replaced: z.string().default(notesDefault.replaced),
            deactivated: z.string().default(notesDefault.deactivated),
            deleted: z.string().default(notesDefault.deleted),
            kept: z.string().default(notesDefault.kept),
            alreadyInactive: z.string().default(notesDefault.alreadyInactive),
            removedKeys: z.string().default(notesDefault.removedKeys),
            fetched: z.string().default(notesDefault.fetched),
            managed: z.string().default(notesDefault.managed),
            notEditable: z.string().default(notesDefault.notEditable),
          })
          .default(notesDefault),
      })
      .default(rollbackDefault),
  }),
);

export type ReleasesPolicy = z.output<typeof releasesSection.schema>;
