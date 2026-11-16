import type { Actor } from "@/server/aws/clients";

/**
 * Hooks that run in the worker after the apply job of a plan ends with the
 * plan in state "applied" (no failed items), including a retried job that
 * finds the plan already applied. A hook reads the plan itself and must be
 * idempotent. A failing hook is logged and never fails the apply job: the
 * writes are done by then.
 *
 * Revisions register one (src/server/revisions/jobs.ts) to tag a release
 * after a plan made from a revision is applied.
 */

export interface PlanAppliedEvent {
  planId: string;
  spaceId: string;
  /** The user who started the apply job */
  actor: Actor;
  log: (message: string, extra?: Record<string, unknown>) => void;
}

export type PlanAppliedHook = (event: PlanAppliedEvent) => Promise<void>;

const hooks = new Set<PlanAppliedHook>();

/** Register a hook (once per function). Returns a function that removes it. */
export function onPlanApplied(hook: PlanAppliedHook): () => void {
  hooks.add(hook);
  return () => hooks.delete(hook);
}

/** Run every registered hook in registration order; errors are logged, not thrown. */
export async function notifyPlanApplied(event: PlanAppliedEvent): Promise<void> {
  for (const hook of hooks) {
    try {
      await hook(event);
    } catch (err) {
      event.log("a plan-applied hook failed", { error: err instanceof Error ? err.message.slice(0, 300) : String(err).slice(0, 300) });
    }
  }
}
