import { z } from "zod";
import { defineSection } from "./define";

/** A template string whose {placeholders} are all in `allowed`. */
function template(allowed: readonly string[]) {
  return z
    .string()
    .min(1)
    .refine((t) => [...t.matchAll(/\{(\w+)\}/g)].every((m) => allowed.includes(m[1]!)), `placeholders must be among ${allowed.map((a) => `{${a}}`).join(" ")}`);
}

const uploadsDefault = { retentionDays: 30, expireCron: "29 3 * * *" };
const importDefault = {
  planTitle: "Import {fileName}",
  blockPlanOnErrors: true,
  listPageSize: 50,
};
const exportDefault = {
  packageName: "{spaceAlias}-{ref}",
  recentCommits: 20,
  gitReadConcurrency: 4,
  blockOnFailedChecks: false,
  notes: {
    path: "reference/EXPORT-NOTES.md",
    title: "# Export notes",
    intro: "The space's assets at {ref} don't pass every package check in the {layout} layout. The space already holds each asset, so every one is in this zip as it is.",
    none: "No asset was left out.",
    remaining: "## Package check errors",
  },
};

/**
 * Package import and export. The read caps for uploads are limits.yaml
 * `packageRead`; the layouts are package-layouts.yaml.
 */
export const packageIoSection = defineSection(
  "package-io.yaml",
  z.object({
    uploads: z
      .object({
        /** Uploaded packages are kept this many days under DAM_DATA_DIR/package-imports, then deleted */
        retentionDays: z.number().int().min(1).default(uploadsDefault.retentionDays),
        /** Cron (UTC) for the job that deletes expired uploads */
        expireCron: z.string().default(uploadsDefault.expireCron),
      })
      .default(uploadsDefault),
    import: z
      .object({
        /** Title of the plan created from an import. Placeholders: {packageName} {fileName} {spaceAlias} */
        planTitle: template(["packageName", "fileName", "spaceAlias"]).default(importDefault.planTitle),
        /** Refuse to create a plan while the package has validation errors */
        blockPlanOnErrors: z.boolean().default(importDefault.blockPlanOnErrors),
        /** Imports per page on the import list */
        listPageSize: z.number().int().min(1).max(500).default(importDefault.listPageSize),
      })
      .default(importDefault),
    export: z
      .object({
        /** Package name (and zip top folder). Placeholders: {spaceAlias} {ref} {layout} */
        packageName: template(["spaceAlias", "ref", "layout"]).default(exportDefault.packageName),
        /** Recent commits offered as export points, besides HEAD and release tags */
        recentCommits: z.number().int().min(0).max(500).default(exportDefault.recentCommits),
        /** Parallel git reads when reading a space's assets at a commit */
        gitReadConcurrency: z.number().int().min(1).max(32).default(exportDefault.gitReadConcurrency),
        /** Refuse the download while the package fails its checks (pages/package-import.md, "Export dialog"). false: download every asset, with the errors in the notes file */
        blockOnFailedChecks: z.boolean().default(exportDefault.blockOnFailedChecks),
        /** The notes file a download with errors carries */
        notes: z
          .object({
            /** Package path of the note (a non-asset path of the layout); null: no note */
            path: z.string().min(1).nullable().default(exportDefault.notes.path),
            title: z.string().min(1).default(exportDefault.notes.title),
            /** Placeholders: {ref} {layout} */
            intro: template(["ref", "layout"]).default(exportDefault.notes.intro),
            /** Shown when no asset was left out */
            none: z.string().min(1).default(exportDefault.notes.none),
            /** Heading over the errors still in the package */
            remaining: z.string().min(1).default(exportDefault.notes.remaining),
          })
          .default(exportDefault.notes),
      })
      .default(exportDefault),
  }),
);
