import { User, Users } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import type { RoleHolder, RoleSummary } from "@/server/spaces/roles-view";
import { roleLabel } from "./labels";
import { SettingsCard } from "./settings-card";

function Holder({ h, bypassName }: { h: RoleHolder; bypassName: string | null }) {
  const Icon = h.kind === "group" ? Users : User;
  return (
    <li className="flex flex-wrap items-center gap-x-1.5">
      <Icon className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
      <span className="sr-only">{h.kind === "group" ? "Group:" : "Person:"}</span>
      {h.kind === "bypass" && bypassName ? <span>{bypassName}</span> : null}
      <span className="font-mono text-xs break-all">{h.subject}</span>
      {h.scope === "global" ? <span className="text-xs text-muted-foreground">(all spaces)</span> : null}
      {h.scope === "bypass" ? <span className="text-xs text-muted-foreground">(you, local sign-in bypass)</span> : null}
    </li>
  );
}

/**
 * "Who can do what": each role's description from policy, the caller's own
 * role, and who holds each role here. Space settings shows it to Admins; the
 * space's "Who can do what" page shows it to everyone who can see the space.
 */
export function RolesCard({
  spaceName,
  roles,
  myRole,
  canChange,
  bypass,
  title = "Who can do what",
}: {
  spaceName: string;
  roles: RoleSummary[];
  myRole: string | null;
  /** The caller can change roles here (spaces.manage or bindings.manage) */
  canChange: boolean;
  bypass: { name: string; email: string; role: string } | null;
  title?: string;
}) {
  return (
    <SettingsCard
      id="roles"
      title={title}
      description={`Roles in ${spaceName}. Roles given for all spaces in App settings also apply here; when several match, the highest one wins.`}
    >
      <div className="space-y-1 px-4 pt-2 text-[13px]">
        <p>
          Your role here: <span className="font-semibold">{myRole ? roleLabel(myRole) : "None"}</span>.
          {bypass ? " The local sign-in bypass sets it." : canChange ? null : " An Admin of this space, listed below, can change it."}
        </p>
        {bypass ? (
          <p className="max-w-[72ch] text-xs text-muted-foreground">
            The local sign-in bypass is on, so everyone who opens the app is {bypass.name} with the {roleLabel(bypass.role)} role. The people and groups listed get their
            roles when they sign in through your sign-in provider.
          </p>
        ) : null}
      </div>
      <Table className="mt-2">
        <TableHeader>
          <TableRow>
            <TableHead className="w-32 pl-4">Role</TableHead>
            <TableHead>What it can do</TableHead>
            <TableHead className="pr-4">Who has it here</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {roles.map((r) => (
            <TableRow key={r.name} className="align-top">
              <TableCell className="py-2 pl-4">
                <span className="inline-flex items-center gap-1.5 font-semibold">
                  {roleLabel(r.name)}
                  {myRole === r.name ? <Badge variant="outline">You</Badge> : null}
                </span>
              </TableCell>
              <TableCell className="max-w-[44ch] py-2 whitespace-normal">{r.description}</TableCell>
              <TableCell className="py-2 pr-4 whitespace-normal">
                {r.holders.length ? (
                  <ul className="space-y-0.5">
                    {r.holders.map((h) => (
                      <Holder key={`${h.kind}:${h.subject}`} h={h} bypassName={bypass?.name ?? null} />
                    ))}
                  </ul>
                ) : (
                  <span className="text-muted-foreground">Nobody</span>
                )}
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </SettingsCard>
  );
}
