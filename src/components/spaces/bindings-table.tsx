import { User, Users } from "lucide-react";
import { EmptyState } from "@/components/common/empty-state";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { RemoveBindingButton } from "./binding-forms";
import type { FormState } from "./form-state";
import { roleLabel } from "./labels";

export interface BindingTableRow {
  id: string;
  scopeLabel: string;
  subjectType: "user" | "group";
  subject: string;
  role: string;
  createdBy: string;
  remove: (prev: FormState) => Promise<FormState>;
  blockedReason: string | null;
}

/** Role bindings with a Remove button per row. `showScope` adds the Scope column (App settings). */
export function BindingsTable({ rows, showScope, emptyText }: { rows: BindingTableRow[]; showScope: boolean; emptyText: string }) {
  if (rows.length === 0) return <EmptyState title="No bindings yet">{emptyText}</EmptyState>;
  return (
    <Table>
      <TableHeader>
        <TableRow>
          {showScope ? <TableHead className="pl-4">Scope</TableHead> : null}
          <TableHead className={showScope ? undefined : "pl-4"}>Person or group</TableHead>
          <TableHead>Role</TableHead>
          <TableHead>Added by</TableHead>
          <TableHead className="pr-4 text-right">
            <span className="sr-only">Actions</span>
          </TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {rows.map((b) => {
          const Icon = b.subjectType === "user" ? User : Users;
          return (
            <TableRow key={b.id}>
              {showScope ? <TableCell className="pl-4">{b.scopeLabel}</TableCell> : null}
              <TableCell className={showScope ? undefined : "pl-4"}>
                <span className="inline-flex items-center gap-1.5">
                  <Icon className="size-3.5 text-muted-foreground" aria-hidden />
                  <span className="sr-only">{b.subjectType === "user" ? "User" : "Group"}:</span>
                  <span className="font-mono text-xs">{b.subject}</span>
                </span>
              </TableCell>
              <TableCell>{roleLabel(b.role)}</TableCell>
              <TableCell className="text-xs text-muted-foreground">{b.createdBy}</TableCell>
              <TableCell className="pr-4 text-right whitespace-normal">
                <RemoveBindingButton action={b.remove} subject={b.subject} role={b.role} scopeLabel={b.scopeLabel} blockedReason={b.blockedReason} />
              </TableCell>
            </TableRow>
          );
        })}
      </TableBody>
    </Table>
  );
}
