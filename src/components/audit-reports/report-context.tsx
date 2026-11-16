"use client";

import { createContext, useContext, type ReactNode } from "react";
import type { ReportActions } from "./action-state";

interface ReportContextValue {
  alias: string;
  auditId: string;
  actions: ReportActions;
}

const Ctx = createContext<ReportContextValue | null>(null);

/** The space, the audit and the Server Actions, for every client control on the Report tab. */
export function ReportProvider({ alias, auditId, actions, children }: ReportContextValue & { children: ReactNode }) {
  return <Ctx.Provider value={{ alias, auditId, actions }}>{children}</Ctx.Provider>;
}

export function useReport(): ReportContextValue {
  const v = useContext(Ctx);
  if (!v) throw new Error("useReport needs a ReportProvider");
  return v;
}
