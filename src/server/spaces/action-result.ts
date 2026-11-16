import "server-only";
import { z } from "zod";
import type { FormState } from "@/components/spaces/form-state";
import { AuthError } from "@/server/auth/dal";
import { SpaceServiceError } from "./errors";
import { fieldErrors } from "./validators";

/** String values of a submitted form, without React's internal $ACTION_ fields. */
export function formValues(form: FormData): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of form.entries()) if (typeof v === "string" && !k.startsWith("$ACTION")) out[k] = v;
  return out;
}

/** Map an error from a Server Action to form state. Unknown errors are rethrown. */
export function errorState(err: unknown, values: Record<string, string> = {}): FormState {
  if (err instanceof AuthError) {
    return { ok: false, message: err.status === 401 ? "Sign in again to continue." : "You don't have permission to do this.", fieldErrors: {}, values };
  }
  if (err instanceof SpaceServiceError) return { ok: false, message: err.message, fieldErrors: err.fieldErrors, values };
  if (err instanceof z.ZodError) {
    return { ok: false, message: "Nothing was saved. Fix the fields marked above, then save again.", fieldErrors: fieldErrors(err), values };
  }
  throw err;
}

export function okState(message: string, extra: Partial<FormState> = {}): FormState {
  return { ok: true, message, fieldErrors: {}, values: {}, ...extra };
}
