/** State returned by the spaces module's Server Actions to their forms (useActionState). */
export interface FormState {
  ok: boolean;
  message: string | null;
  /** Field name (dotted, as in the form) to message */
  fieldErrors: Record<string, string>;
  /** Submitted values, so a rejected form keeps what the user typed */
  values: Record<string, string>;
  /** Set when the action started a background job */
  runId?: string | null;
}

export const initialFormState: FormState = { ok: false, message: null, fieldErrors: {}, values: {} };
