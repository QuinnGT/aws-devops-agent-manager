"use client";

import { type FormEvent, useActionState, useEffect, useRef, useTransition } from "react";
import { toast } from "sonner";
import { type FormState, initialFormState } from "./form-state";

/** Toast the confirmation once per successful save (MASTER: toasts confirm, they never carry errors). */
export function useSavedToast(state: FormState): void {
  const shown = useRef<FormState | null>(null);
  useEffect(() => {
    if (state.ok && state.message && shown.current !== state) {
      shown.current = state;
      toast.success(state.message);
    }
  }, [state]);
}

/**
 * A form bound to a Server Action that returns FormState. Submits through
 * onSubmit instead of `<form action>`, so React doesn't reset the form
 * afterwards: what the user typed stays after a rejected save, and checkboxes
 * keep their state after a successful one.
 */
export function useActionForm(action: (prev: FormState, form: FormData) => Promise<FormState>, opts: { toast?: boolean } = {}) {
  const [state, dispatch, pending] = useActionState(action, initialFormState);
  const [, startTransition] = useTransition();
  useSavedToast(opts.toast === false ? initialFormState : state);
  const onSubmit = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const data = new FormData(e.currentTarget);
    startTransition(() => dispatch(data));
  };
  const error = (name: string): string | undefined => state.fieldErrors[name];
  return { state, pending, onSubmit, error };
}
