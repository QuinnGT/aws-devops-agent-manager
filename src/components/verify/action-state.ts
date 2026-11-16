/** Result of a "Run check" Server Action on the release Verification tab. */
export type RunCheckState =
  | { status: "idle" }
  | { status: "started"; runId: string | null; alreadyOpen: boolean }
  | { status: "error"; message: string };

export const initialRunCheckState: RunCheckState = { status: "idle" };
