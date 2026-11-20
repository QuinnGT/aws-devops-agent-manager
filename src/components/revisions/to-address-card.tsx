"use client";

import { TriangleAlert } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import type { ActionResult } from "@/components/plans/action-state";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { incidentAndText } from "./editor-state";

/** A finding on the revision's to-address list (ToAddressView in src/server/revisions/views.ts). */
export interface ToAddressItem {
  id: string;
  title: string;
  incidentId: string | null;
  kindLabel: string;
  owner: string | null;
  ownerLabel: string | null;
  auditName: string;
  auditHref: string | null;
  href: string | null;
  accepted: boolean;
  notAcceptedReason: string | null;
}

export type RemoveToAddressAction = (findingId: string) => Promise<ActionResult<{ removed: boolean }>>;

/** Findings listed before "Show all". */
export const TO_ADDRESS_SHOWN = 8;

const link = "underline underline-offset-4 hover:text-foreground";

/**
 * "To address" (revision-detail.md, right rail): the findings sent to this
 * revision from an audit that no save has linked yet. Each shows its incident
 * ID, kind, owner, full title and audit, with a link to the finding on its
 * audit's page. A finding reopened or rejected on its audit stays listed and
 * says so; it can't be linked until it is accepted again. "Remove" needs
 * `revisions.build` and an open revision.
 */
export function ToAddressCard({ items, canRemove, removeAction, auditsHref }: { items: ToAddressItem[]; canRemove: boolean; removeAction: RemoveToAddressAction; auditsHref: string }) {
  const router = useRouter();
  const [showAll, setShowAll] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [removing, setRemoving] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const accepted = items.filter((i) => i.accepted).length;
  const notAccepted = items.length - accepted;
  const shown = showAll ? items : items.slice(0, TO_ADDRESS_SHOWN);

  const remove = (id: string) =>
    start(async () => {
      setError(null);
      setRemoving(id);
      const r = await removeAction(id);
      setRemoving(null);
      if (!r.ok) {
        setError(r.message);
        return;
      }
      router.refresh();
    });

  return (
    <Card className="gap-0 py-0" role="region" aria-labelledby="rev-to-address-h">
      <div className="flex min-h-12 items-center justify-between gap-3 border-b px-4 py-2">
        <h2 id="rev-to-address-h" className="text-sm font-semibold">
          To address
        </h2>
        <span className="text-xs text-muted-foreground tabular-nums">{accepted}</span>
      </div>
      {items.length === 0 ? (
        <p className="px-4 py-3 text-[13px] text-muted-foreground">
          Nothing sent from an audit. Accepted fixes added to this revision from an{" "}
          <Link href={auditsHref} className={link}>
            audit
          </Link>{" "}
          are listed here until a save links them.
        </p>
      ) : (
        <>
          {notAccepted > 0 ? (
            <p className="border-b px-4 py-2 text-xs text-muted-foreground">
              {notAccepted === 1 ? "1 finding is" : `${notAccepted} findings are`} no longer accepted on {notAccepted === 1 ? "its audit" : "their audits"}. {notAccepted === 1 ? "It stays" : "They stay"} here until {notAccepted === 1 ? "it is" : "they are"} accepted again or you remove {notAccepted === 1 ? "it" : "them"}.
            </p>
          ) : null}
          <ul>
            {shown.map((f) => {
              const t = incidentAndText(f.title, f.incidentId);
              const detail = [f.kindLabel, f.owner ? `${f.ownerLabel ?? "Owner"}: ${f.owner}` : null].filter(Boolean).join(" · ");
              return (
                <li key={f.id} className="grid grid-cols-[minmax(0,1fr)_auto] items-start gap-x-2 border-b px-4 py-2.5 text-[13px] last:border-b-0">
                  <div className="min-w-0">
                    <p className="break-words">
                      {t.incident ? <b className="mr-1.5">{t.incident}</b> : null}
                      {f.href ? (
                        <Link href={f.href} className="underline-offset-4 hover:underline">
                          {t.text}
                        </Link>
                      ) : (
                        t.text
                      )}
                    </p>
                    {detail ? <p className="text-xs text-muted-foreground">{detail}</p> : null}
                    {f.auditName ? (
                      <p className="text-xs break-words text-muted-foreground">
                        {f.auditHref ? (
                          <Link href={f.auditHref} className={link}>
                            {f.auditName}
                          </Link>
                        ) : (
                          f.auditName
                        )}
                      </p>
                    ) : null}
                    {f.notAcceptedReason ? (
                      <p className="mt-1 flex items-start gap-1 text-xs text-warning-fg">
                        <TriangleAlert className="mt-0.5 size-3.5 shrink-0" aria-hidden />
                        <span>{f.notAcceptedReason}</span>
                      </p>
                    ) : null}
                  </div>
                  {canRemove ? (
                    <Button variant="ghost" size="sm" onClick={() => remove(f.id)} disabled={pending} aria-label={`Remove ${f.incidentId ?? f.title} from the to-address list`}>
                      {removing === f.id ? "Removing…" : "Remove"}
                    </Button>
                  ) : null}
                </li>
              );
            })}
          </ul>
        </>
      )}
      {error ? (
        <p role="alert" className="border-t px-4 py-2 text-xs text-destructive-fg">
          {error}
        </p>
      ) : null}
      {items.length > TO_ADDRESS_SHOWN ? (
        <div className="border-t px-4 py-1.5 text-center">
          <Button variant="ghost" size="sm" aria-expanded={showAll} onClick={() => setShowAll((v) => !v)}>
            {showAll ? "Show fewer" : `Show all ${items.length}`}
          </Button>
        </div>
      ) : null}
    </Card>
  );
}
