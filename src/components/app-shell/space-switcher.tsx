"use client";

import { ChevronsUpDown, Folder, Plus } from "lucide-react";
import Link from "next/link";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { SidebarMenu, SidebarMenuButton, SidebarMenuItem } from "@/components/ui/sidebar";
import { cn } from "@/lib/utils";
import { spaceBase } from "./nav";
import { CONNECTION_WORDS, initials, spaceSubtitle, type ShellSpace } from "./types";

/** Space switcher at the top of the sidebar: spaces with Region and connection, then All spaces and Register a space (Admins). */
export function SpaceSwitcher({ spaces, current, canRegister }: { spaces: ShellSpace[]; current: ShellSpace | null; canRegister: boolean }) {
  return (
    <SidebarMenu>
      <SidebarMenuItem>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <SidebarMenuButton
              size="lg"
              variant="outline"
              className="h-12 data-[state=open]:bg-sidebar-accent"
              aria-label={current ? `Switch space, current: ${current.name}` : "Choose a space"}
            >
              <span className="grid size-8 shrink-0 place-items-center rounded-lg bg-primary text-xs font-semibold text-primary-foreground" aria-hidden>
                {current ? initials(current.name) : <Folder className="size-4" />}
              </span>
              <span className="grid min-w-0 flex-1 text-left leading-tight">
                <span className="truncate text-[13px] font-semibold">{current ? current.name : "Choose a space"}</span>
                <span className="truncate text-xs text-muted-foreground">{current ? spaceSubtitle(current) : `${spaces.length} available`}</span>
              </span>
              <ChevronsUpDown className="ml-auto size-4 text-muted-foreground" aria-hidden />
            </SidebarMenuButton>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" className="w-(--radix-dropdown-menu-trigger-width) min-w-60">
            <DropdownMenuLabel className="text-xs text-muted-foreground">Spaces</DropdownMenuLabel>
            {spaces.length === 0 ? <DropdownMenuItem disabled>No spaces you can open yet</DropdownMenuItem> : null}
            {spaces.map((s) => {
              const c = CONNECTION_WORDS[s.connection] ?? CONNECTION_WORDS.unknown!;
              return (
                <DropdownMenuItem key={s.alias} asChild>
                  <Link href={spaceBase(s.alias)} aria-current={current?.alias === s.alias ? "true" : undefined}>
                    <span className={cn("size-2 shrink-0 rounded-full", c.dot)} aria-hidden />
                    <span className="grid min-w-0 flex-1 leading-tight">
                      <span className="truncate">{s.name}</span>
                      <span className="truncate text-xs text-muted-foreground">
                        {spaceSubtitle(s)}
                        <span className="sr-only">, {c.text}</span>
                      </span>
                    </span>
                  </Link>
                </DropdownMenuItem>
              );
            })}
            <DropdownMenuSeparator />
            <DropdownMenuItem asChild>
              <Link href="/spaces">
                <Folder aria-hidden />
                All spaces
              </Link>
            </DropdownMenuItem>
            {canRegister ? (
              <DropdownMenuItem asChild>
                <Link href="/spaces/new">
                  <Plus aria-hidden />
                  Register a space
                </Link>
              </DropdownMenuItem>
            ) : null}
          </DropdownMenuContent>
        </DropdownMenu>
      </SidebarMenuItem>
    </SidebarMenu>
  );
}
