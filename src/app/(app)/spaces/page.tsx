import { Plus } from "lucide-react";
import Link from "next/link";
import { syncIntervalFor } from "@/components/app-shell/space-top-bar";
import { TopBar } from "@/components/app-shell/top-bar";
import { ConnectionNextStep } from "@/components/common/connection-next-step";
import { EmptyState } from "@/components/common/empty-state";
import { PageHeader } from "@/components/common/page-header";
import { connectionStatusSpec } from "@/components/common/status-words";
import { SyncStatus } from "@/components/common/sync-status";
import { daysAgo } from "@/components/common/time-format";
import { buttonVariants } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { can, requireUserOrRedirect } from "@/server/auth/dal";
import { countChangesSinceBySpace } from "@/server/assets/feed";
import { getSyncState } from "@/server/assets/queries";
import { plainErrorText } from "@/server/jobs/error-text";
import { connectionView } from "@/server/spaces/connection-state";
import { listHistoryRepos } from "@/server/spaces/history-repos";
import { listSpaces } from "@/server/spaces/queries";

const TONE_TEXT: Record<string, string> = { success: "text-success-fg", destructive: "text-destructive-fg" };

/** All spaces (MASTER "Page index"). Also rendered at `/`. */
export default async function SpacesPage() {
  const user = await requireUserOrRedirect();
  const [spaces, repos, canRegister] = await Promise.all([listSpaces(), listHistoryRepos(), can(user, "spaces.manage", null)]);
  const visible = [];
  for (const s of spaces) if (await can(user, "assets.read", s.id)) visible.push(s);
  const repoName = new Map(repos.map((r) => [r.id, r.name]));
  const [syncs, manage, recent] = await Promise.all([
    Promise.all(visible.map((s) => getSyncState(s.id))),
    Promise.all(visible.map((s) => can(user, "spaces.manage", s.id))),
    countChangesSinceBySpace(
      visible.map((s) => s.id),
      daysAgo(7),
    ),
  ]);

  return (
    <div className="mx-auto max-w-7xl space-y-4">
      <TopBar crumbs={[{ label: "All spaces" }]} />
      <PageHeader
        title="All spaces"
        meta={[`${visible.length} ${visible.length === 1 ? "space" : "spaces"} you can open`]}
        actions={
          canRegister ? (
            <Link href="/spaces/new" className={buttonVariants({ size: "sm" })}>
              <Plus aria-hidden />
              Register a space
            </Link>
          ) : undefined
        }
      />
      <Card className="gap-0 py-0">
        {visible.length === 0 ? (
          <EmptyState title={spaces.length === 0 ? "No spaces registered yet" : "No spaces you can open"}>
            {spaces.length === 0
              ? canRegister
                ? "Register an Agent Space to start recording its history."
                : "An Admin registers Agent Spaces. Ask one to add yours."
              : "Ask an Admin for a role binding in the space you need."}
          </EmptyState>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="pl-4">Name</TableHead>
                <TableHead>Region</TableHead>
                <TableHead>Connection</TableHead>
                <TableHead>Sync</TableHead>
                <TableHead className="text-right">Changes, last 7 days</TableHead>
                <TableHead className="pr-4">History repository</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {visible.map((s, i) => {
                const sync = syncs[i];
                const conn = connectionView(s, sync);
                const c = connectionStatusSpec(conn.status);
                const syncError = sync?.status === "error" ? plainErrorText(sync.error) : null;
                return (
                  <TableRow key={s.id}>
                    <TableCell className="pl-4">
                      <Link className="inline-flex min-h-6 items-center font-medium underline-offset-4 hover:underline" href={`/spaces/${encodeURIComponent(s.alias)}`}>
                        {s.displayName ?? s.alias}
                      </Link>
                      {s.parsedSettings.environment ? <span className="ml-2 text-xs text-muted-foreground">{s.parsedSettings.environment}</span> : null}
                    </TableCell>
                    <TableCell>{s.region}</TableCell>
                    <TableCell className="max-w-xs whitespace-normal">
                      <span className="inline-flex items-center gap-1.5">
                        {c.icon ? <c.icon className={`size-4 ${TONE_TEXT[c.tone] ?? "text-muted-foreground"}`} aria-hidden /> : null}
                        {c.label}
                      </span>
                      {conn.cause ? (
                        <p className="text-xs text-muted-foreground">
                          {conn.cause}
                          {conn.needsSettings ? (
                            <>
                              {" "}
                              <ConnectionNextStep alias={s.alias} canManage={manage[i] ?? false} />
                            </>
                          ) : null}
                        </p>
                      ) : null}
                    </TableCell>
                    <TableCell className="max-w-xs whitespace-normal">
                      <SyncStatus
                        compact
                        lastCompletedAt={sync?.lastSyncCompletedAt?.toISOString() ?? null}
                        status={sync?.status ?? null}
                        error={syncError}
                        intervalMinutes={syncIntervalFor(s)}
                      />
                      {/* The cause in the row, unless the Connection column already says it. */}
                      {syncError && syncError !== conn.cause ? <p className="text-xs text-muted-foreground">{syncError}</p> : null}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">{recent.get(s.id) ?? 0}</TableCell>
                    <TableCell className="pr-4 font-mono text-xs">{s.historyRepoId ? (repoName.get(s.historyRepoId) ?? "") : "None"}</TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        )}
      </Card>
    </div>
  );
}
