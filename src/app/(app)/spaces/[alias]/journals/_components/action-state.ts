/** Result of the journals Server Actions, shown under each form. */
export type ActionState = { status: "idle" } | { status: "error"; message: string } | { status: "ok"; message: string; id: string };

export const initialActionState: ActionState = { status: "idle" };
