"use client";

import { createAuthClient } from "better-auth/react";
import { ChevronsUpDown, Lock, LogOut, Monitor, Moon, Sun, Users } from "lucide-react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useTheme } from "next-themes";
import { useEffect, useState } from "react";
import { PhaseBadge } from "@/components/common/phase-badge";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  useSidebar,
} from "@/components/ui/sidebar";
import { cn } from "@/lib/utils";
import { roleDescriptionsAction } from "./actions";
import { CommandSearch } from "./command-search";
import { aliasFromPath, isActive, NAV_GROUPS, navHref, spaceBase, visibleGroups, type NavItem } from "./nav";
import { SpaceSwitcher } from "./space-switcher";
import { initials, LAST_SPACE_COOKIE, roleLabel, type ShellFlags, type ShellSpace, type ShellUser } from "./types";

const authClient = createAuthClient();

function visible(item: NavItem, space: ShellSpace | null, flags: ShellFlags): boolean {
  switch (item.requires.kind) {
    case "signed-in":
      return true;
    case "app":
      return flags[item.requires.flag];
    case "space":
      return Boolean(space?.permissions.includes(item.requires.permission));
  }
}

function UserMenu({ user, role, spaceName, alias }: { user: ShellUser; role: string | null; spaceName: string | null; alias: string | null }) {
  const { theme, setTheme } = useTheme();
  const router = useRouter();
  const [descriptions, setDescriptions] = useState<Record<string, string> | null>(null);
  const loadDescriptions = (open: boolean) => {
    if (open && !descriptions) void roleDescriptionsAction().then(setDescriptions, () => setDescriptions({}));
  };
  return (
    <SidebarMenu>
      <SidebarMenuItem>
        <DropdownMenu onOpenChange={loadDescriptions}>
          <DropdownMenuTrigger asChild>
            <SidebarMenuButton size="lg" className="h-12 data-[state=open]:bg-sidebar-accent" aria-label={`Account menu, ${user.name}`}>
              <span className="grid size-7 shrink-0 place-items-center rounded-full bg-sidebar-accent text-[11px] font-semibold" aria-hidden>
                {initials(user.name)}
              </span>
              <span className="grid min-w-0 flex-1 text-left leading-tight">
                <span className="truncate text-[13px] font-semibold">{user.name}</span>
                <span className="truncate text-xs text-muted-foreground">{roleLabel(role)}</span>
              </span>
              <ChevronsUpDown className="ml-auto size-4 text-muted-foreground" aria-hidden />
            </SidebarMenuButton>
          </DropdownMenuTrigger>
          <DropdownMenuContent side="top" align="start" className="w-(--radix-dropdown-menu-trigger-width) min-w-56">
            <DropdownMenuLabel className="grid font-normal">
              <span className="truncate font-medium">{user.name}</span>
              <span className="truncate text-xs text-muted-foreground">{user.email}</span>
            </DropdownMenuLabel>
            <DropdownMenuSeparator />
            <div className="grid gap-0.5 px-2 py-1.5 text-xs">
              <span className="font-medium">
                {roleLabel(role)}
                {role && spaceName ? <span className="font-normal text-muted-foreground"> in {spaceName}</span> : null}
              </span>
              {role && descriptions?.[role] ? <span className="text-muted-foreground">{descriptions[role]}</span> : null}
              {user.devBypass ? <span className="text-muted-foreground">Signed in through the local sign-in bypass.</span> : null}
            </div>
            {alias ? (
              <DropdownMenuItem asChild>
                <Link href={`${spaceBase(alias)}/roles`}>
                  <Users aria-hidden />
                  See who has each role
                </Link>
              </DropdownMenuItem>
            ) : null}
            <DropdownMenuSeparator />
            <DropdownMenuLabel className="text-xs text-muted-foreground">Theme</DropdownMenuLabel>
            <DropdownMenuRadioGroup value={theme ?? "system"} onValueChange={setTheme}>
              <DropdownMenuRadioItem value="light">
                <Sun aria-hidden />
                Light
              </DropdownMenuRadioItem>
              <DropdownMenuRadioItem value="dark">
                <Moon aria-hidden />
                Dark
              </DropdownMenuRadioItem>
              <DropdownMenuRadioItem value="system">
                <Monitor aria-hidden />
                System
              </DropdownMenuRadioItem>
            </DropdownMenuRadioGroup>
            <DropdownMenuSeparator />
            {user.devBypass ? (
              <>
                <DropdownMenuItem disabled aria-describedby="sign-out-reason">
                  <LogOut aria-hidden />
                  Sign out
                </DropdownMenuItem>
                <p id="sign-out-reason" className="flex items-center gap-1.5 px-2 pb-1.5 text-xs text-muted-foreground">
                  <Lock className="size-3.5 shrink-0" aria-hidden />
                  The local sign-in bypass keeps you signed in.
                </p>
              </>
            ) : (
              <DropdownMenuItem
                onSelect={async () => {
                  await authClient.signOut();
                  router.push("/sign-in");
                  router.refresh();
                }}
              >
                <LogOut aria-hidden />
                Sign out
              </DropdownMenuItem>
            )}
          </DropdownMenuContent>
        </DropdownMenu>
      </SidebarMenuItem>
    </SidebarMenu>
  );
}

/** The app's sidebar (shadcn Sidebar, offcanvas): space switcher, search, navigation and the account menu. */
export function AppSidebar({ spaces, user, flags, lastAlias }: { spaces: ShellSpace[]; user: ShellUser; flags: ShellFlags; lastAlias: string | null }) {
  const pathname = usePathname();
  const pathAlias = aliasFromPath(pathname);
  const byAlias = (a: string | null) => (a ? (spaces.find((s) => s.alias === a) ?? null) : null);
  const current = byAlias(pathAlias) ?? byAlias(lastAlias) ?? (spaces.length === 1 ? spaces[0]! : null);

  const known = Boolean(pathAlias && spaces.some((s) => s.alias === pathAlias));
  const { isMobile, setOpenMobile } = useSidebar();

  useEffect(() => {
    if (known && pathAlias) document.cookie = `${LAST_SPACE_COOKIE}=${encodeURIComponent(pathAlias)}; path=/; max-age=31536000; samesite=lax`;
  }, [known, pathAlias]);

  return (
    <Sidebar variant="sidebar" collapsible="offcanvas">
      <SidebarHeader className="gap-2 p-2.5">
        <SpaceSwitcher spaces={spaces} current={current} canRegister={flags.registerSpace} />
        <CommandSearch alias={current?.alias ?? null} spaceName={current?.name ?? null} />
      </SidebarHeader>
      <SidebarContent className="gap-0">
        <nav aria-label="Main">
          {visibleGroups(NAV_GROUPS, (i) => visible(i, current, flags)).map(({ label, items }) => {
            const group = { label };
            return (
              <SidebarGroup key={group.label} className="py-1.5">
                <SidebarGroupLabel className="text-xs font-semibold text-muted-foreground">{group.label}</SidebarGroupLabel>
                <SidebarMenu className="gap-px">
                  {items.map((item) => {
                    const href = navHref(item, current?.alias ?? null);
                    if (!href) return null;
                    const active = isActive(item, href, pathname);
                    const Icon = item.icon;
                    return (
                      <SidebarMenuItem key={item.key}>
                        <SidebarMenuButton asChild isActive={active} className={cn("text-[13.5px]", active && "font-semibold", item.placeholder && "text-muted-foreground")}>
                          <Link href={href} aria-current={active ? "page" : undefined} onClick={() => isMobile && setOpenMobile(false)}>
                            <Icon aria-hidden />
                            <span className="flex-1 truncate">{item.label}</span>
                            {item.placeholder ? <PhaseBadge phase={item.phase} /> : null}
                          </Link>
                        </SidebarMenuButton>
                      </SidebarMenuItem>
                    );
                  })}
                </SidebarMenu>
              </SidebarGroup>
            );
          })}
        </nav>
      </SidebarContent>
      <SidebarFooter className="border-t border-sidebar-border p-2.5">
        <UserMenu user={user} role={current?.role ?? user.globalRole} spaceName={current?.role ? current.name : null} alias={current?.alias ?? null} />
      </SidebarFooter>
    </Sidebar>
  );
}
