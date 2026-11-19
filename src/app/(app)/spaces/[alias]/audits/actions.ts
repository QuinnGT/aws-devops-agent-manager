"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import type { AuditActionResult } from "@/components/audits/action-state";
import { noCredentialsText } from "@/server/ai/error-kind";
import { AuthError, permissionsIn, requirePermission } from "@/server/auth/dal";
import { AuditRequestError } from "@/server/audits/errors";
import { acceptAllProposed, checkCitation, reviewFinding, type FindingActionInput } from "@/server/audits/finding-review";
import { selectionSchema } from "@/server/audits/selection";
import { addAuditItems, cancelAudit, createAudit, deleteAudit, removeAuditItems, rerunFailedItems, rerunItem, setAuditModels, startAudit, updateAuditDraft } from "@/server/audits/service";
import { listPickableInvestigations, previewSelection, type SelectionPreview } from "@/server/audits/ui";
import type { Permission } from "@/server/policy";
import { actorOf } from "@/server/spaces/actor";
import { getSpaceByAlias } from "@/server/spaces/queries";

/**
 * Server Actions of the audit pages (pages/audits.md, audit-new.md,
 * audit-detail.md, audit-item.md). Each finds the space by alias, checks the
 * permission for that space with the DAL (audits.run for the audit's
 * lifecycle and inputs, findings.review for findings), parses the input with
 * Zod and calls the audits service with the signed-in user as the actor. The
 * service checks that the audit, item or finding belongs to that space.
 */

const NO_ACCESS = "You don't have permission to do this in this space.";
const alias = z.string().trim().min(1).max(200);
const uuid = z.string().uuid();
const modelId = z.string().trim().max(300).nullish();
/** The reviewer choice; the service checks it against policy. */
const reviewer = { runner: z.string().trim().max(50).nullish(), runnerOptions: z.record(z.string().max(100), z.string().max(100)).nullish() };

type Fail = Extract<AuditActionResult, { ok: false }>;

function fail(err: unknown): Fail {
  if (err instanceof AuthError) return { ok: false, message: err.status === 401 ? "Sign in again to continue." : NO_ACCESS, fieldErrors: {} };
  if (err instanceof AuditRequestError) return { ok: false, message: err.message, fieldErrors: {}, code: err.code, details: err.details };
  if (err instanceof z.ZodError) {
    const fieldErrors: Record<string, string> = {};
    for (const i of err.issues) {
      const k = i.path.join(".");
      if (k && !fieldErrors[k]) fieldErrors[k] = i.message;
    }
    return { ok: false, message: err.issues[0]?.message ?? "Check the form and try again.", fieldErrors };
  }
  throw err;
}

/** The space for the alias and the signed-in user, once they hold `permission` there. */
async function authorize(rawAlias: unknown, permission: Permission) {
  const a = alias.parse(rawAlias);
  const space = await getSpaceByAlias(a);
  if (!space) throw new AuthError(403, "No such space");
  const user = await requirePermission(permission, space.id);
  return { space, user, actor: actorOf(user) };
}

const base = (a: string) => `/spaces/${encodeURIComponent(a)}/audits`;

// ---------------------------------------------------------------- New audit and drafts

const createInput = z.object({
  name: z.string().max(200),
  profileId: z.string().trim().min(1).max(100),
  note: z.string().max(2000).optional(),
  selections: z.array(selectionSchema).min(1, "Choose at least one investigation.").max(20),
  reviewModelId: modelId,
  reportModelId: modelId,
  ...reviewer,
});

export async function createAuditAction(spaceAlias: string, input: z.input<typeof createInput>): Promise<AuditActionResult<{ auditId: string; items: number }>> {
  try {
    const { space, actor } = await authorize(spaceAlias, "audits.run");
    const req = createInput.parse(input);
    if (!req.name.trim()) return { ok: false, message: "Enter a name.", fieldErrors: { name: "Enter a name." } };
    const r = await createAudit(actor, space.id, { ...req, reviewModelId: req.reviewModelId || null, reportModelId: req.reportModelId || null, runner: req.runner || null });
    revalidatePath(base(space.alias));
    return { ok: true, ...r };
  } catch (err) {
    return fail(err);
  }
}

const draftInput = z.object({ name: z.string().max(200), reviewModelId: modelId, reportModelId: modelId, ...reviewer });

/** "Save draft" on a saved draft: its name, reviewer and models. */
export async function saveDraftAction(spaceAlias: string, auditId: string, input: z.input<typeof draftInput>): Promise<AuditActionResult> {
  try {
    const { space, actor } = await authorize(spaceAlias, "audits.run");
    const id = uuid.parse(auditId);
    const req = draftInput.parse(input);
    if (!req.name.trim()) return { ok: false, message: "Enter a name.", fieldErrors: { name: "Enter a name." } };
    await updateAuditDraft(actor, space.id, id, { name: req.name });
    await setAuditModels(actor, space.id, id, { reviewModelId: req.reviewModelId ?? "", reportModelId: req.reportModelId ?? "", runner: req.runner, runnerOptions: req.runnerOptions });
    revalidatePath(`${base(space.alias)}/${id}`);
    return { ok: true };
  } catch (err) {
    return fail(err);
  }
}

export async function addItemsAction(spaceAlias: string, auditId: string, selections: unknown): Promise<AuditActionResult<{ added: number; items: number }>> {
  try {
    const { space, actor } = await authorize(spaceAlias, "audits.run");
    const r = await addAuditItems(actor, space.id, uuid.parse(auditId), z.array(selectionSchema).min(1).max(20).parse(selections));
    revalidatePath(`${base(space.alias)}/${auditId}`);
    return { ok: true, ...r };
  } catch (err) {
    return fail(err);
  }
}

export async function removeItemsAction(spaceAlias: string, auditId: string, itemIds: string[]): Promise<AuditActionResult<{ removed: number }>> {
  try {
    const { space, actor } = await authorize(spaceAlias, "audits.run");
    const r = await removeAuditItems(actor, space.id, uuid.parse(auditId), z.array(uuid).min(1).max(500).parse(itemIds));
    revalidatePath(`${base(space.alias)}/${auditId}`);
    return { ok: true, ...r };
  } catch (err) {
    return fail(err);
  }
}

/** What a selection would add: found investigations and IDs without a cached journal. Reads only. */
export async function previewSelectionAction(spaceAlias: string, selection: unknown, docKinds: string[] = []): Promise<AuditActionResult<{ preview: SelectionPreview }>> {
  try {
    const { space } = await authorize(spaceAlias, "audits.run");
    const kinds = z.array(z.string().regex(/^[a-z][a-z0-9_-]*$/)).max(20).parse(docKinds);
    return { ok: true, preview: await previewSelection(space.id, selectionSchema.parse(selection), kinds) };
  } catch (err) {
    return fail(err);
  }
}

const pickInput = z.object({ q: z.string().max(200).optional(), status: z.string().max(64).optional() });

/** Cached investigations for the "Pick from journals" dialog. Reads only. */
export async function pickableInvestigationsAction(
  spaceAlias: string,
  input: z.input<typeof pickInput>,
): Promise<AuditActionResult<{ rows: { taskId: string; incidentId: string | null; title: string | null; status: string | null; createdAt: string | null }[]; total: number }>> {
  try {
    const { space } = await authorize(spaceAlias, "audits.run");
    const f = pickInput.parse(input);
    const r = await listPickableInvestigations(space.id, { q: f.q, status: f.status || null, limit: 200 });
    return { ok: true, total: r.total, rows: r.rows.map((x) => ({ ...x, createdAt: x.createdAt?.toISOString() ?? null })) };
  } catch (err) {
    return fail(err);
  }
}

export async function startAuditAction(spaceAlias: string, auditId: string, opts: { skipIncomplete?: boolean } = {}): Promise<AuditActionResult<{ items: number; skipped: number }>> {
  try {
    const { space, actor, user } = await authorize(spaceAlias, "audits.run");
    try {
      const r = await startAudit(actor, space.id, uuid.parse(auditId), { skipIncomplete: z.boolean().optional().parse(opts.skipIncomplete) });
      revalidatePath(base(space.alias));
      return { ok: true, items: r.items, skipped: r.skipped };
    } catch (err) {
      // No AWS credentials: the next step depends on whether the caller can open Space settings.
      if (err instanceof AuditRequestError && err.details?.bedrock === "no-credentials" && !(await permissionsIn(user, space.id)).has("spaces.manage")) {
        return { ok: false, message: noCredentialsText(false), fieldErrors: {}, code: err.code, details: err.details };
      }
      throw err;
    }
  } catch (err) {
    return fail(err);
  }
}

export async function cancelAuditAction(spaceAlias: string, auditId: string): Promise<AuditActionResult> {
  try {
    const { space, actor } = await authorize(spaceAlias, "audits.run");
    await cancelAudit(actor, space.id, uuid.parse(auditId));
    revalidatePath(base(space.alias));
    return { ok: true };
  } catch (err) {
    return fail(err);
  }
}

export async function deleteDraftAction(spaceAlias: string, auditId: string): Promise<AuditActionResult> {
  try {
    const { space, actor } = await authorize(spaceAlias, "audits.run");
    await deleteAudit(actor, space.id, uuid.parse(auditId));
    revalidatePath(base(space.alias));
    return { ok: true };
  } catch (err) {
    return fail(err);
  }
}

/**
 * Review one investigation again. When its current review has decided
 * findings the service asks for confirmation (code "confirm"); the page shows
 * that message in a dialog and repeats the call with `confirmReplace`.
 */
export async function rerunItemAction(spaceAlias: string, auditId: string, itemId: string, confirmReplace = false): Promise<AuditActionResult> {
  try {
    const { space, actor } = await authorize(spaceAlias, "audits.run");
    await rerunItem(actor, space.id, uuid.parse(auditId), uuid.parse(itemId), { confirmReplace: z.boolean().parse(confirmReplace) });
    revalidatePath(`${base(space.alias)}/${auditId}`);
    return { ok: true };
  } catch (err) {
    return fail(err);
  }
}

/** "Rerun <N> failed reviews": the failed items a rerun can fix. Failed reviews have no findings, so nothing needs confirming. */
export async function rerunFailedAction(spaceAlias: string, auditId: string): Promise<AuditActionResult<{ queued: number; left: number }>> {
  try {
    const { space, actor } = await authorize(spaceAlias, "audits.run");
    const id = uuid.parse(auditId);
    const r = await rerunFailedItems(actor, space.id, id);
    revalidatePath(`${base(space.alias)}/${id}`);
    return { ok: true, ...r };
  } catch (err) {
    return fail(err);
  }
}

// ---------------------------------------------------------------- findings

const findingInput = z.discriminatedUnion("action", [
  z.object({ action: z.literal("accept"), note: z.string().max(2000).optional(), values: z.record(z.string().max(100), z.unknown()).optional() }),
  z.object({ action: z.literal("reject"), note: z.string().max(2000).optional() }),
  z.object({ action: z.literal("reopen"), note: z.string().max(2000).optional() }),
  z.object({ action: z.literal("edit"), note: z.string().max(2000).optional(), values: z.record(z.string().max(100), z.unknown()) }),
]);

/** Accept, reject, reopen ("Change decision") or edit one finding. */
export async function findingAction(spaceAlias: string, findingId: string, input: FindingActionInput): Promise<AuditActionResult<{ state: string; edited: boolean }>> {
  try {
    const { space, actor } = await authorize(spaceAlias, "findings.review");
    const r = await reviewFinding(actor, space.id, uuid.parse(findingId), findingInput.parse(input));
    revalidatePath(base(space.alias), "layout");
    return { ok: true, state: r.state, edited: r.edited };
  } catch (err) {
    return fail(err);
  }
}

const citationCheckInput = z.object({ record: z.number().int().min(1).max(10_000_000), note: z.string().max(500) });

/** "I checked the record" on a failed citation chip: who read the record and what they found, kept with the finding. */
export async function checkCitationAction(spaceAlias: string, findingId: string, input: z.input<typeof citationCheckInput>): Promise<AuditActionResult<{ checked: number }>> {
  try {
    const { space, actor } = await authorize(spaceAlias, "findings.review");
    const req = citationCheckInput.parse(input);
    if (!req.note.trim()) return { ok: false, message: "Say what you found in the record.", fieldErrors: { note: "Say what you found in the record." } };
    const r = await checkCitation(actor, space.id, uuid.parse(findingId), req);
    revalidatePath(base(space.alias), "layout");
    return { ok: true, checked: r.checked };
  } catch (err) {
    return fail(err);
  }
}

/** Bulk accept for one incident: proposed findings whose citations all passed or were checked. */
export async function acceptAllAction(spaceAlias: string, auditId: string, itemId: string): Promise<AuditActionResult<{ accepted: number; skipped: number }>> {
  try {
    const { space, actor } = await authorize(spaceAlias, "findings.review");
    const r = await acceptAllProposed(actor, space.id, uuid.parse(auditId), uuid.parse(itemId));
    revalidatePath(base(space.alias), "layout");
    return { ok: true, ...r };
  } catch (err) {
    return fail(err);
  }
}
