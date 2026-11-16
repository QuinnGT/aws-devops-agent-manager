/**
 * What the audit Server Actions return to their client components. `code`
 * is the audits module's error code ("confirm" asks the user to repeat the
 * action with the confirmation flag; `message` says what would be replaced).
 */
export type AuditActionResult<T = unknown> =
  | ({ ok: true } & T)
  | { ok: false; message: string; fieldErrors: Record<string, string>; code?: string; details?: Record<string, unknown> };

export function actionMessage(r: AuditActionResult<unknown> | null): string | null {
  return r && !r.ok ? r.message : null;
}
