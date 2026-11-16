import { randomUUID } from "node:crypto";
import { z } from "zod";
import { TRAILERS } from "@/lib/assets/types";
import { recordAuditEvent } from "@/server/audit-log";
import type { Actor } from "@/server/aws/clients";
import { db } from "@/server/db/client";
import { assetReasons } from "@/server/db/schema";
import type { HistoryRepo } from "@/server/git/history-repo";
import type { JobContext } from "@/server/jobs/registry";
import { getAppPolicy } from "@/server/policy";
import { getHistoryRepoForSpace, getSpaceById, toHistoryRepoConfig } from "@/server/spaces/queries";
import { ASSET_BROWSER, URL_ASSET_ID, URL_COMMIT } from "./config";
import { getAssetChangeByCommit, type AssetChange } from "./queries";
import { openExistingHistoryRepo } from "./repo";

/**
 * Change reasons for changes made outside the app. The web process validates and enqueues; the worker
 * appends the git note under historyLayout.notesRef and indexes it in
 * asset_reasons. A Reason-Id line in the note makes a retried job a no-op.
 */

const httpLink = z
  .string()
  .trim()
  .max(2000)
  .refine((s) => {
    try {
      const u = new URL(s);
      return u.protocol === "https:" || u.protocol === "http:";
    } catch {
      return false;
    }
  }, "Enter a full http or https link");

export const addReasonRequest = z.object({
  spaceId: z.string().uuid(),
  assetId: z.string().regex(URL_ASSET_ID, "Unknown asset"),
  commit: z.string().regex(URL_COMMIT, "Unknown commit"),
  reason: z.string().trim().min(1, "Enter a reason").max(ASSET_BROWSER.maxReasonChars, `Keep the reason under ${ASSET_BROWSER.maxReasonChars} characters`),
  link: z.preprocess((v) => (typeof v === "string" && v.trim() === "" ? null : v), httpLink.nullable().default(null)),
});

export const addReasonInput = addReasonRequest.extend({ reasonId: z.string().uuid() });

export type AddReasonRequest = z.input<typeof addReasonRequest>;
export type AddReasonInput = z.output<typeof addReasonInput>;

export class ReasonError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ReasonError";
  }
}

/** Reasons can be added to changes made outside the app; app applies record theirs at apply time. */
export function canAddReason(change: Pick<AssetChange, "changeSource">): boolean {
  return change.changeSource !== "app";
}

/** Check that the change exists in this space and accepts a reason. */
export async function validateAddReason(input: Pick<AddReasonInput, "spaceId" | "assetId" | "commit">): Promise<AssetChange> {
  const space = await getSpaceById(input.spaceId);
  if (!space) throw new ReasonError("Space not found");
  const change = await getAssetChangeByCommit(input.spaceId, input.assetId, input.commit);
  if (!change) throw new ReasonError("That change is not recorded for this asset");
  if (!canAddReason(change)) throw new ReasonError("Changes applied through the app record their reason when they are applied");
  return change;
}

export function formatReasonNote(input: Pick<AddReasonInput, "reason" | "link" | "reasonId">, actor: Actor, at: Date): string {
  const lines = [`Reason: ${input.reason.replace(/\r?\n/g, "\n  ")}`];
  if (input.link) lines.push(`Link: ${input.link}`);
  lines.push(`Added-By: ${actor.email}`, `Added-At: ${at.toISOString()}`, `Reason-Id: ${input.reasonId}`);
  return lines.join("\n");
}

/** Assign the reason ID used for idempotency and validate. The caller enqueues. */
export async function prepareAddReason(request: AddReasonRequest): Promise<AddReasonInput> {
  const parsed = addReasonRequest.parse(request);
  await validateAddReason(parsed);
  return { ...parsed, reasonId: randomUUID() };
}

async function commitBelongsToAsset(repo: HistoryRepo, commit: string, assetId: string): Promise<boolean> {
  const [entry] = await repo.log({ ref: commit, maxCount: 1 });
  if (!entry || entry.hash !== commit) return false;
  const id = entry.trailers[TRAILERS.assetId];
  return id === undefined || id === assetId;
}

export interface AddReasonResult {
  reasonId: string;
  commit: string;
  /** False when the note was already present (a retried job) */
  noteAdded: boolean;
  pushed: boolean;
  pushError?: string;
}

/** Worker handler for assets.add-reason. */
export async function addReasonHandler(input: AddReasonInput, ctx: JobContext): Promise<AddReasonResult> {
  const policy = getAppPolicy().policy;
  const notesRef = policy.historyLayout.notesRef;
  await validateAddReason(input);
  const space = await getSpaceById(input.spaceId);
  const repoRow = space ? await getHistoryRepoForSpace(space) : null;
  if (!repoRow) throw new ReasonError("This space has no history repository");
  const repo = await openExistingHistoryRepo(toHistoryRepoConfig(repoRow));
  if (!repo) throw new ReasonError(`The history repository ${repoRow.name} has no working copy`);
  if (!(await commitBelongsToAsset(repo, input.commit, input.assetId))) throw new ReasonError("That commit is not in the history repository for this asset");
  await ctx.progress(0.3, "Adding the note");

  const existing = await repo.note(input.commit, notesRef);
  const marker = `Reason-Id: ${input.reasonId}`;
  let noteAdded = false;
  if (!existing?.split("\n").some((l) => l.trim() === marker)) {
    const author = { name: ctx.actor.email, email: ctx.actor.email };
    await repo.addNote(input.commit, formatReasonNote(input, ctx.actor, new Date()), notesRef, { author, committer: policy.sync.committer });
    noteAdded = true;
  }
  await db()
    .insert(assetReasons)
    .values({
      id: input.reasonId,
      spaceId: input.spaceId,
      assetId: input.assetId,
      commit: input.commit,
      reason: input.reason,
      link: input.link,
      notesRef,
      addedBy: ctx.actor.email,
      jobRunId: /^[0-9a-f-]{36}$/i.test(ctx.runId) ? ctx.runId : null,
    })
    .onConflictDoNothing({ target: assetReasons.id });

  await ctx.progress(0.7, "Pushing the note");
  let pushed = false;
  let pushError: string | undefined;
  try {
    pushed = await repo.push(notesRef);
  } catch (err) {
    // The reason is saved locally and indexed; the next push carries the notes ref.
    pushError = err instanceof Error ? err.message.slice(0, 300) : String(err);
    ctx.log("push failed after adding a reason", { error: pushError });
  }

  if (noteAdded) {
    await recordAuditEvent({
      actor: ctx.actor,
      action: "asset.reason.add",
      spaceId: input.spaceId,
      targetType: "asset",
      targetId: input.assetId,
      details: { commit: input.commit, reasonId: input.reasonId, link: input.link, pushed, ...(pushError ? { pushError } : {}) },
    });
  }
  await ctx.progress(1, "Reason added");
  return { reasonId: input.reasonId, commit: input.commit, noteAdded, pushed, ...(pushError ? { pushError } : {}) };
}

/** The URL if it is http or https, else null (notes can be written outside the app). */
export function safeHttpUrl(s: string | null | undefined): string | null {
  if (!s) return null;
  try {
    const u = new URL(s);
    return u.protocol === "https:" || u.protocol === "http:" ? u.toString() : null;
  } catch {
    return null;
  }
}

const NOTE_FIELD = /^(Link|Added-By|Added-At|Reason-Id): /;

export interface ParsedReasonNote {
  reason: string;
  link: string | null;
  addedBy: string | null;
  addedAt: string | null;
  raw: string;
}

/**
 * Parse a note written by formatReasonNote (or any note) into display parts.
 * `git notes append` separates notes with a blank line and strips trailing
 * whitespace, so a reason's own blank lines can't be told apart from note
 * boundaries by blank lines alone: notes written by the app are split at their
 * "Reason: " lines, other notes at blank lines.
 */
export function parseReasonNotes(note: string): ParsedReasonNote[] {
  const lines = note.replace(/\r\n/g, "\n").split("\n");
  const blocks: string[][] = [];
  if (lines.some((l) => l.startsWith("Reason: "))) {
    for (const l of lines) {
      if (l.startsWith("Reason: ") || blocks.length === 0) blocks.push([]);
      blocks.at(-1)!.push(l);
    }
  } else {
    for (const b of note.split(/\n{2,}/)) blocks.push(b.split("\n"));
  }
  return blocks
    .filter((b) => b.some((l) => l.trim()))
    .map((b) => {
      const raw = b.join("\n").trim();
      const get = (k: string) => b.find((l) => l.startsWith(`${k}: `))?.slice(k.length + 2).trim() ?? null;
      let reason = raw;
      if (b[0]?.startsWith("Reason: ")) {
        const parts = [b[0].slice("Reason: ".length)];
        for (let i = 1; i < b.length && !NOTE_FIELD.test(b[i]!); i++) parts.push(b[i]!.startsWith("  ") ? b[i]!.slice(2) : b[i]!);
        reason = parts.join("\n").trimEnd();
      }
      return { reason, link: get("Link"), addedBy: get("Added-By"), addedAt: get("Added-At"), raw };
    });
}
