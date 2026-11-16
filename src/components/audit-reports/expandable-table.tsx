"use client";

import { useState, type ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { Table, TableBody } from "@/components/ui/table";

/**
 * A table that shows its first `initial` rows and a "Show all <N> ..." button
 * in the card footer. `foot` rows (a median row) always show.
 */
export function ExpandableTable({ head, rows, foot, initial = 3, moreLabel, label }: { head: ReactNode; rows: ReactNode[]; foot?: ReactNode; initial?: number; moreLabel: string; label: string }) {
  const [all, setAll] = useState(false);
  const shown = all ? rows : rows.slice(0, initial);
  return (
    <>
      <Table aria-label={label}>
        {head}
        <TableBody>
          {shown}
          {foot}
        </TableBody>
      </Table>
      {rows.length > initial ? (
        <div className="border-t px-2 py-1.5">
          <Button variant="ghost" size="sm" aria-expanded={all} onClick={() => setAll((v) => !v)}>
            {all ? "Show fewer" : moreLabel}
          </Button>
        </div>
      ) : null}
    </>
  );
}
