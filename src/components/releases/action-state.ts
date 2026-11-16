/** States returned by the release Server Actions to their forms. */

export type CreateReleaseState =
  | { status: "idle" }
  | { status: "error"; message: string; fieldErrors: Record<string, string> }
  | { status: "started"; runId: string; name: string };

export type NameCheckState = { ok: true } | { ok: false; message: string };

export type RollbackPlanState = { status: "idle" } | { status: "error"; message: string; fieldErrors: Record<string, string>; problems: string[] };

export type CreateReleaseAction = (prev: CreateReleaseState, formData: FormData) => Promise<CreateReleaseState>;
export type CheckNameAction = (name: string) => Promise<NameCheckState>;
export type RollbackPlanAction = (prev: RollbackPlanState, formData: FormData) => Promise<RollbackPlanState>;
