/**
 * What the plan and draft Server Actions return to their client components.
 * `fieldErrors` keys are form field names; the component shows each under
 * its field with role="alert". `message` is a page-level error.
 */
export type ActionResult<T = unknown> =
  | ({ ok: true } & T)
  | { ok: false; message: string; fieldErrors: Record<string, string> };

export function fieldError(r: ActionResult<unknown> | null, field: string): string | null {
  return r && !r.ok ? (r.fieldErrors[field] ?? null) : null;
}
