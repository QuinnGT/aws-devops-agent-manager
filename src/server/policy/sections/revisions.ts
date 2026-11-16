import { z } from "zod";
import { defineSection } from "./define";

/**
 * Revisions: a git branch
 * (history-layout.yaml revisionBranch) holding an instruction package under
 * history-layout.yaml packageDir, edited with saves that link accepted audit
 * findings. policy/revisions.yaml documents each key.
 */

/** A template string whose {placeholders} are all in `allowed`. */
function template(allowed: readonly string[]) {
  return z
    .string()
    .min(1)
    .refine((t) => [...t.matchAll(/\{(\w+)\}/g)].every((m) => allowed.includes(m[1]!)), `placeholders must be among ${allowed.map((a) => `{${a}}`).join(" ")}`);
}

function compiles(pattern: string): boolean {
  try {
    new RegExp(pattern);
    return true;
  } catch {
    return false;
  }
}

/** What a save that links no finding needs. */
export const UNLINKED_SAVE_RULES = ["refuse", "reason", "allow"] as const;
export type UnlinkedSaveRule = (typeof UNLINKED_SAVE_RULES)[number];

const nameDefault = {
  pattern: "^[A-Za-z0-9](?:[A-Za-z0-9._-]{0,62}[A-Za-z0-9])?$",
  hint: "Use 1 to 64 letters, numbers, dots, hyphens and underscores, starting and ending with a letter or number, for example v2.4.",
  maxLength: 64,
  uniqueIgnoringCase: true,
};
const committerDefault = { name: "DevOps Agent Manager", email: "revisions@devops-agent-manager.invalid" };
const createDefault = {
  syncBeforeCreate: true,
  commitMessage: "Start revision {name} of {spaceAlias} from {base}",
  noteMaxChars: 2000,
  baseLabels: { live: "the live space", release: "release {release}" },
};
const saveDefault = {
  unlinked: "reason" as UnlinkedSaveRule,
  messageMaxChars: 200,
  reasonMinChars: 10,
  reasonMaxChars: 1000,
  maxFindings: 20,
  maxFiles: 500,
  maxBytes: 10 * 1024 * 1024,
};
const trailersDefault = { revisionId: "Revision-Id", findingId: "Finding-Id", changeId: "Revision-Change-Id", unlinkedReason: "Unlinked-Reason" };
const changelogDefault = {
  path: "reference/CHANGELOG.md",
  title: "# Change record",
  heading: "## {name}, {date}",
  intro: "Source: {base}. Generated from the revision's changes and the accepted audit findings each change links to.",
  begin: "<!-- revision: {name} (generated from the revision's changes; edits between these markers are replaced on the next save) -->",
  end: "<!-- /revision: {name} -->",
  columns: { change: "Change", files: "Files", audit: "Audit", incident: "Incident", finding: "Finding", evidence: "Evidence" },
  unlinked: "Not linked to a finding: {reason}",
  none: "None",
  noChanges: "No changes yet.",
  maxFilesListed: 5,
  maxCitations: 5,
  maxQuoteChars: 120,
};
const planDefault = {
  title: "Apply revision {name}",
  reason: "Revision {name}: {changes}. Findings: {findings}.",
  noFindings: "none linked",
};
const releaseDefault = { name: "{name}", note: "Applied from revision {name} (plan {planId})." };
const exportDefault = { requirePassingBuild: true };
const pagesDefault = { listPageSize: 50, maxDiffBytes: 200_000, maxFileBytes: 512_000, maxResults: 200 };

export const revisionsSection = defineSection(
  "revisions.yaml",
  z.object({
    name: z
      .object({
        /** Regex a revision name must match. The name becomes part of a branch, a folder and the release tagged after apply. */
        pattern: z.string().refine(compiles, "not a valid regular expression").default(nameDefault.pattern),
        hint: z.string().default(nameDefault.hint),
        maxLength: z.number().int().min(1).max(200).default(nameDefault.maxLength),
        /** Names that differ only in case collide as branches and folders on case-insensitive file systems */
        uniqueIgnoringCase: z.boolean().default(nameDefault.uniqueIgnoringCase),
      })
      .default(nameDefault),
    /** The package folder ({package} in history-layout.yaml packageDir), also the zip's top folder. Placeholders: {name} {spaceAlias} */
    packageName: template(["name", "spaceAlias"]).default("{name}"),
    /** Author of every revision commit is the user; this is the committer */
    committer: z.object({ name: z.string().min(1), email: z.string().min(1) }).default(committerDefault),
    create: z
      .object({
        /** Sync the space (a reconcile) before reading the live space, as a release of HEAD does */
        syncBeforeCreate: z.boolean().default(createDefault.syncBeforeCreate),
        /** First commit on the branch. Placeholders: {name} {spaceAlias} {base} */
        commitMessage: template(["name", "spaceAlias", "base"]).default(createDefault.commitMessage),
        noteMaxChars: z.number().int().min(0).default(createDefault.noteMaxChars),
        /** How the base is named in commit messages, the change record and pages */
        baseLabels: z
          .object({
            live: z.string().min(1).default(createDefault.baseLabels.live),
            /** Placeholder: {release} */
            release: template(["release"]).default(createDefault.baseLabels.release),
          })
          .default(createDefault.baseLabels),
      })
      .default(createDefault),
    save: z
      .object({
        /** A save that links no finding: refuse it, require a written reason, or allow it */
        unlinked: z.enum(UNLINKED_SAVE_RULES).default(saveDefault.unlinked),
        /** Longest change message (the commit subject) */
        messageMaxChars: z.number().int().min(1).max(1000).default(saveDefault.messageMaxChars),
        reasonMinChars: z.number().int().min(0).default(saveDefault.reasonMinChars),
        reasonMaxChars: z.number().int().min(1).default(saveDefault.reasonMaxChars),
        /** Most findings one save may link */
        maxFindings: z.number().int().min(1).default(saveDefault.maxFindings),
        /** Most files one save may write or delete */
        maxFiles: z.number().int().min(1).default(saveDefault.maxFiles),
        /** Most bytes of file content one save may carry */
        maxBytes: z.number().int().min(1).default(saveDefault.maxBytes),
      })
      .default(saveDefault),
    /** Commit trailers on revision commits */
    trailers: z
      .object({
        revisionId: z.string().regex(/^[A-Za-z][A-Za-z0-9-]*$/).default(trailersDefault.revisionId),
        findingId: z.string().regex(/^[A-Za-z][A-Za-z0-9-]*$/).default(trailersDefault.findingId),
        /** Lets a retried save find its own commit */
        changeId: z.string().regex(/^[A-Za-z][A-Za-z0-9-]*$/).default(trailersDefault.changeId),
        unlinkedReason: z.string().regex(/^[A-Za-z][A-Za-z0-9-]*$/).default(trailersDefault.unlinkedReason),
      })
      .default(trailersDefault),
    changelog: z
      .object({
        /** Package path of the change record; null: do not write one (the preview still works) */
        path: z.string().min(1).nullable().default(changelogDefault.path),
        /** First line of a change record that doesn't exist yet */
        title: z.string().min(1).default(changelogDefault.title),
        /** Placeholders: {name} {date} */
        heading: template(["name", "date"]).default(changelogDefault.heading),
        /** Placeholders: {name} {base} */
        intro: template(["name", "base"]).default(changelogDefault.intro),
        /** Markers around the generated section. Placeholder: {name} */
        begin: template(["name"]).default(changelogDefault.begin),
        end: template(["name"]).default(changelogDefault.end),
        columns: z
          .object({
            change: z.string().min(1).default(changelogDefault.columns.change),
            files: z.string().min(1).default(changelogDefault.columns.files),
            audit: z.string().min(1).default(changelogDefault.columns.audit),
            incident: z.string().min(1).default(changelogDefault.columns.incident),
            finding: z.string().min(1).default(changelogDefault.columns.finding),
            evidence: z.string().min(1).default(changelogDefault.columns.evidence),
          })
          .default(changelogDefault.columns),
        /** Evidence cell of a change with no finding. Placeholder: {reason} */
        unlinked: template(["reason"]).default(changelogDefault.unlinked),
        /** Cell text when there is nothing to show */
        none: z.string().min(1).default(changelogDefault.none),
        /** Section body before the first save */
        noChanges: z.string().min(1).default(changelogDefault.noChanges),
        maxFilesListed: z.number().int().min(1).default(changelogDefault.maxFilesListed),
        /** Record citations listed per finding */
        maxCitations: z.number().int().min(0).default(changelogDefault.maxCitations),
        maxQuoteChars: z.number().int().min(10).default(changelogDefault.maxQuoteChars),
      })
      .default(changelogDefault),
    plan: z
      .object({
        /** Placeholders: {name} {spaceAlias} */
        title: template(["name", "spaceAlias"]).default(planDefault.title),
        /** Prefilled change reason. Placeholders: {name} {changes} {findings} */
        reason: template(["name", "changes", "findings"]).default(planDefault.reason),
        /** {findings} when no change links a finding */
        noFindings: z.string().min(1).default(planDefault.noFindings),
      })
      .default(planDefault),
    release: z
      .object({
        /** Release tagged when the revision's plan is applied. Placeholders: {name} {spaceAlias} */
        name: template(["name", "spaceAlias"]).default(releaseDefault.name),
        /** Placeholders: {name} {planId} */
        note: template(["name", "planId"]).default(releaseDefault.note),
      })
      .default(releaseDefault),
    export: z
      .object({
        /** Refuse the package download until the latest build passed */
        requirePassingBuild: z.boolean().default(exportDefault.requirePassingBuild),
      })
      .default(exportDefault),
    /** Push revision branches after each commit when the repository allows pushes */
    pushBranches: z.boolean().default(true),
    pages: z
      .object({
        listPageSize: z.number().int().min(1).max(500).default(pagesDefault.listPageSize),
        /** Largest diff text the detail page receives */
        maxDiffBytes: z.number().int().min(1000).default(pagesDefault.maxDiffBytes),
        /** Largest file the detail page shows inline */
        maxFileBytes: z.number().int().min(1000).default(pagesDefault.maxFileBytes),
        /** Build results listed on the detail page */
        maxResults: z.number().int().min(1).default(pagesDefault.maxResults),
      })
      .default(pagesDefault),
  }),
);

export type RevisionsPolicy = z.output<typeof revisionsSection.schema>;
