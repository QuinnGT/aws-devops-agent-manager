import { z } from "zod";
import { AuthError } from "@/server/auth/dal";
import { PlanServiceError } from "./types";

/**
 * Turn an error from a plan or draft Server Action into the result its form
 * shows: AuthError, PlanServiceError (with its field errors) and Zod input
 * errors become messages; anything else is rethrown.
 */
export function actionError(err: unknown): { ok: false; message: string; fieldErrors: Record<string, string> } {
  if (err instanceof AuthError) {
    return { ok: false, message: err.status === 401 ? "Sign in again to continue." : "You don't have permission to do this in this space.", fieldErrors: {} };
  }
  if (err instanceof PlanServiceError) return { ok: false, message: err.message, fieldErrors: err.fieldErrors };
  if (err instanceof z.ZodError) {
    const fieldErrors: Record<string, string> = {};
    for (const issue of err.issues) {
      const key = issue.path.join(".");
      if (key && !fieldErrors[key]) fieldErrors[key] = issue.message;
    }
    return { ok: false, message: err.issues[0]?.message ?? "Check the form and try again.", fieldErrors };
  }
  throw err;
}
