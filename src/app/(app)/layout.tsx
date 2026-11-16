import { cookies } from "next/headers";
import { AppSidebar } from "@/components/app-shell/app-sidebar";
import { NAV_SPACE_PERMISSIONS } from "@/components/app-shell/nav";
import { TopBar } from "@/components/app-shell/top-bar";
import { TzCookie } from "@/components/app-shell/tz-cookie";
import { LAST_SPACE_COOKIE, safeDecode, type ShellSpace } from "@/components/app-shell/types";
import { TZ_COOKIE } from "@/components/common/viewer-zone";
import { SidebarProvider } from "@/components/ui/sidebar";
import { requireUserOrRedirect, roleFor } from "@/server/auth/dal";
import { permissionsForRole } from "@/server/auth/roles";
import { getAppPolicy } from "@/server/policy";
import { getSyncState } from "@/server/assets/queries";
import { connectionView } from "@/server/spaces/connection-state";
import { listSpaces } from "@/server/spaces/queries";

/**
 * App shell (design-system MASTER "Shell"): skip link, sidebar, and <main>.
 * Each page renders its own TopBar (fixed beside the sidebar) with its crumbs.
 */
export default async function AppLayout({ children }: LayoutProps<"/">) {
  const user = await requireUserOrRedirect();
  const [spaces, jar, globalRole] = await Promise.all([listSpaces(), cookies(), roleFor(user, null)]);
  const policy = getAppPolicy().policy;
  const globalPerms = globalRole ? permissionsForRole(policy, globalRole) : new Set<string>();

  const shellSpaces: ShellSpace[] = [];
  let anyAuditLog = false;
  let anyBindings = false;
  for (const s of spaces) {
    const role = await roleFor(user, s.id);
    const perms = role ? permissionsForRole(policy, role) : new Set<string>();
    anyAuditLog ||= perms.has("auditlog.read");
    anyBindings ||= perms.has("bindings.manage");
    if (!perms.has("assets.read")) continue;
    shellSpaces.push({
      alias: s.alias,
      name: s.displayName ?? s.alias,
      region: s.region,
      environment: s.parsedSettings.environment,
      // Same status as All spaces and Home: a later sync that failed for a settings cause counts.
      connection: connectionView(s, await getSyncState(s.id)).status,
      role,
      permissions: NAV_SPACE_PERMISSIONS.filter((p) => perms.has(p)),
    });
  }

  const flags = {
    auditLog: globalPerms.has("auditlog.read") || anyAuditLog,
    appSettings: globalPerms.has("spaces.manage") || globalPerms.has("bindings.manage") || anyBindings,
    registerSpace: globalPerms.has("spaces.manage"),
  };

  return (
    <SidebarProvider defaultOpen={jar.get("sidebar_state")?.value !== "false"}>
      <a
        href="#main"
        className="fixed top-2 left-2 z-50 -translate-y-16 rounded-lg bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground focus:translate-y-0"
      >
        Skip to main content
      </a>
      <TzCookie current={jar.get(TZ_COOKIE)?.value ?? null} />
      <AppSidebar
        spaces={shellSpaces}
        user={{ name: user.name, email: user.email, devBypass: user.devBypass, globalRole }}
        flags={flags}
        lastAlias={safeDecode(jar.get(LAST_SPACE_COOKIE)?.value)}
      />
      <div className="flex min-w-0 flex-1 flex-col">
        <TopBar crumbs={[]} fallback />
        <main id="main" tabIndex={-1} className="flex-1 px-6 pt-[72px] pb-8 max-sm:px-4">
          {children}
        </main>
      </div>
    </SidebarProvider>
  );
}
