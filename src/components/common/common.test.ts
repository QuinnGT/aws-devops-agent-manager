import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { FeedItem } from "@/lib/assets/types";
import { ConnectionNextStep } from "./connection-next-step";
import { PhaseBadge } from "./phase-badge";
import { phasePlaceholderText } from "./phase-placeholder";
import { buildFeed, describeChange, describeGroup, listNames, type FeedTerms } from "./feed-groups";
import { displayPrincipal, longSourceLabel, shortSourceLabel, type SourceLabelPolicy } from "./source-labels";
import { CHANGE_WORDS, connectionStatusSpec, sortValidation, STATUS, validationStatus } from "./status-words";
import { syncState, syncStatusText } from "./sync-status-state";
import { dayKey, formatRelative, formatTime, formatUtcExact, resolveTimeZone, UTC_ZONE } from "./time-format";

const LA = resolveTimeZone("America/Los_Angeles");
const NOW = new Date("2026-11-11T23:38:00Z"); // Nov 11, 3:38 PM PST

describe("time formatting", () => {
  it("resolves a known zone and falls back to UTC otherwise", () => {
    expect(LA).toEqual({ timeZone: "America/Los_Angeles", fallback: false });
    expect(resolveTimeZone("Not/AZone")).toEqual(UTC_ZONE);
    expect(resolveTimeZone("'; drop")).toEqual(UTC_ZONE);
    expect(resolveTimeZone(undefined)).toEqual(UTC_ZONE);
  });

  it("formats time, date, datetime and day in the viewer's zone", () => {
    const today = "2026-11-11T22:12:00Z";
    const thisYear = "2026-11-10T23:38:13Z";
    const lastYear = "2025-11-10T23:38:13Z";
    expect(formatTime(thisYear, "time", LA, NOW)).toBe("3:38 PM");
    expect(formatTime(today, "datetime", LA, NOW)).toBe("2:12 PM");
    expect(formatTime(thisYear, "datetime", LA, NOW)).toBe("Nov 10, 3:38 PM");
    expect(formatTime(lastYear, "datetime", LA, NOW)).toBe("Nov 10, 2025");
    expect(formatTime(thisYear, "date", LA, NOW)).toBe("Nov 10");
    expect(formatTime(thisYear, "day", LA, NOW)).toBe("Tuesday, Nov 10");
    expect(formatTime(lastYear, "day", LA, NOW)).toBe("Monday, Nov 10, 2025");
  });

  it("adds UTC to the text when the viewer's zone is unknown", () => {
    // 23:38 UTC on Nov 10 is still Nov 10 in UTC, but Nov 10 3:38 PM in Los Angeles
    expect(formatTime("2026-11-10T23:38:13Z", "time", UTC_ZONE, NOW)).toBe("11:38 PM UTC");
    expect(formatTime("2026-11-10T23:38:13Z", "datetime", UTC_ZONE, NOW)).toBe("Nov 10, 11:38 PM UTC");
    expect(formatTime("2026-11-10T23:38:13Z", "day", UTC_ZONE, NOW)).toBe("Tuesday, Nov 10");
  });

  it("uses the viewer's day boundary", () => {
    // 02:00 UTC on Nov 11 is Nov 10 in Los Angeles
    expect(dayKey("2026-11-11T02:00:00Z", "America/Los_Angeles")).toBe("2026-11-10");
    expect(dayKey("2026-11-11T02:00:00Z", "UTC")).toBe("2026-11-11");
  });

  it("gives an exact UTC tooltip and relative freshness", () => {
    expect(formatUtcExact("2026-11-10T23:38:13.000Z")).toBe("2026-11-10 23:38:13 UTC");
    expect(formatRelative(new Date(NOW.getTime() - 30_000), NOW)).toBe("just now");
    expect(formatRelative(new Date(NOW.getTime() - 12 * 60_000), NOW)).toBe("12 min ago");
    expect(formatRelative(new Date(NOW.getTime() - 2 * 3_600_000), NOW)).toBe("2 h ago");
    expect(formatRelative(new Date(NOW.getTime() - 3 * 86_400_000), NOW)).toBe("3 days ago");
  });
});

describe("sync status", () => {
  const ago = (min: number) => new Date(NOW.getTime() - min * 60_000);

  it("is ok until twice the interval has passed, then stale", () => {
    expect(syncState({ status: "succeeded", lastCompletedAt: ago(29), intervalMinutes: 15 }, NOW)).toBe("ok");
    expect(syncState({ status: "succeeded", lastCompletedAt: ago(30), intervalMinutes: 15 }, NOW)).toBe("stale");
    expect(syncState({ status: "succeeded", lastCompletedAt: ago(59), intervalMinutes: 30 }, NOW)).toBe("ok");
  });

  it("reports running, failed and never before freshness", () => {
    expect(syncState({ status: "running", lastCompletedAt: ago(500), intervalMinutes: 15 }, NOW)).toBe("running");
    expect(syncState({ status: "error", lastCompletedAt: ago(1), intervalMinutes: 15 }, NOW)).toBe("failed");
    expect(syncState({ status: "never", lastCompletedAt: null, intervalMinutes: 15 }, NOW)).toBe("never");
    expect(syncState({ status: "cancelled", lastCompletedAt: null, intervalMinutes: 15 }, NOW)).toBe("never");
    expect(syncState({ status: "cancelled", lastCompletedAt: ago(5), intervalMinutes: 15 }, NOW)).toBe("ok");
  });

  it("always has text next to the dot", () => {
    expect(syncStatusText("ok", ago(12), NOW)).toBe("Synced 12 min ago");
    expect(syncStatusText("stale", ago(120), NOW)).toBe("Last sync 2 h ago");
    expect(syncStatusText("running", null, NOW)).toBe("Syncing");
    expect(syncStatusText("failed", ago(1), NOW)).toBe("Sync failed");
    expect(syncStatusText("never", null, NOW)).toBe("Not synced yet");
  });

  it("says Connection failed when the space isn't connected, unless a sync is running or requested", () => {
    const base = { status: "error", lastCompletedAt: ago(1), intervalMinutes: 15, connectionFailed: true };
    expect(syncState(base, NOW)).toBe("disconnected");
    expect(syncStatusText("disconnected", null, NOW)).toBe("Connection failed");
    expect(syncState({ ...base, job: { status: "running" } }, NOW)).toBe("running");
    expect(syncState({ ...base, job: { status: "queued", waitingForWorker: false } }, NOW)).toBe("requested");
  });

  it("shows a requested sync, and says when no worker has picked it up", () => {
    const base = { status: "error", lastCompletedAt: ago(1), intervalMinutes: 15 };
    expect(syncState({ ...base, job: { status: "queued", waitingForWorker: false } }, NOW)).toBe("requested");
    expect(syncState({ ...base, job: { status: "queued", waitingForWorker: true } }, NOW)).toBe("waiting");
    expect(syncState({ ...base, job: { status: "running" } }, NOW)).toBe("running");
    expect(syncState({ ...base, job: null }, NOW)).toBe("failed");
    expect(syncStatusText("requested", null, NOW)).toBe("Sync requested");
    expect(syncStatusText("waiting", null, NOW)).toBe("Sync waiting for the worker");
  });
});

describe("source labels", () => {
  const p: SourceLabelPolicy = {
    labels: { app: "DevOps Agent Manager", console: "Operator Web App", cli: "CLI or SDK", agent: "DevOps Agent", unknown: "Unknown" },
    shortLabels: { app: "This app", console: "Console", cli: "CLI or SDK", agent: "DevOps Agent", unknown: "Unknown" },
  };

  it("uses the short label for chips and the long label for tooltips", () => {
    expect(shortSourceLabel("agent", p)).toBe("DevOps Agent");
    expect(shortSourceLabel("app", p)).toBe("This app");
    expect(longSourceLabel("agent", p)).toBe("DevOps Agent");
    expect(longSourceLabel("console", p)).toBe("Operator Web App");
  });

  it("prefers the label recorded with the change, except for agent and unknown", () => {
    expect(longSourceLabel("console", p, "Break-glass console")).toBe("Break-glass console");
    expect(longSourceLabel("agent", p, "DevOps Agent (no API call recorded)")).toBe("DevOps Agent");
  });

  it("drops the role's unique ID from a session name, for display only", () => {
    expect(displayPrincipal("AROAEXAMPLEROLEID1234-alex-Admin")).toBe("alex-Admin");
    expect(displayPrincipal("AROAEXAMPLEROLEID1234:dam-session")).toBe("dam-session");
    expect(displayPrincipal("alex-Admin")).toBe("alex-Admin");
    expect(displayPrincipal("arn:aws:iam::123456789012:user/ci")).toBe("arn:aws:iam::123456789012:user/ci");
  });
});

const NOUNS: Record<string, [string, string]> = { memory: ["memory", "memories"], skill: ["skill", "skills"] };
const terms: FeedTerms = {
  typeLabel: (t) => ({ memory: "Memory", skill: "Skill", memory_store: "Memory store" })[t] ?? t,
  noun: (t, n) => (NOUNS[t] ?? [t, `${t}s`])[n === 1 ? 0 : 1],
};

let seq = 0;
function item(p: Partial<FeedItem> & Pick<FeedItem, "at">): FeedItem {
  seq += 1;
  return {
    assetId: `ki-${seq}`,
    assetType: "memory",
    name: `m${seq}`,
    parentName: "chat-tool-use-best-practices",
    parentAssetId: "ki-store",
    version: 2,
    kind: "content",
    source: "agent",
    principal: null,
    commit: `c${seq}`,
    provisional: false,
    hasReason: false,
    ...p,
  };
}

describe("change feed grouping", () => {
  const opts = { timeZone: "America/Los_Angeles", terms };

  it("groups three or more changes with the same source and parent within 15 minutes", () => {
    const items = [
      item({ at: "2026-11-07T18:33:33Z", name: "categories/testing-mcp-servers" }),
      item({ at: "2026-11-07T18:33:33Z", name: "categories/privatelink-cross-region-setup" }),
      item({ at: "2026-11-07T18:33:32Z", name: "categories/privatelink-facts-and-limits" }),
      item({ at: "2026-11-07T18:33:31Z", name: "categories/devops-agent-product-questions" }),
    ];
    const { days } = buildFeed(items, opts);
    expect(days).toHaveLength(1);
    const g = days[0]!.entries[0]!;
    expect(g.kind).toBe("group");
    if (g.kind !== "group") return;
    expect(g.title).toBe("4 changes in chat-tool-use-best-practices");
    expect(g.detail).toBe("4 updated: categories/testing-mcp-servers, categories/privatelink-cross-region-setup and 2 more");
    expect(g).not.toHaveProperty("version");
  });

  it("uses the same title pattern when kinds differ, and says what happened in the detail", () => {
    const items = [item({ at: "2026-11-03T18:38:35Z", kind: "created", version: 1, name: "a" }), item({ at: "2026-11-03T18:38:35Z", kind: "created", version: 1, name: "b" }), item({ at: "2026-11-03T18:38:34Z", name: "overview", version: 23 })];
    const g = describeGroup(items, terms);
    expect(g.title).toBe("3 changes in chat-tool-use-best-practices");
    expect(g.detail).toBe("2 created, 1 updated: a, b and overview");
    expect(listNames(["a", "b", "c"])).toBe("a, b and c");
  });

  it("keeps runs of two, different sources, and changes over 15 minutes apart as single rows", () => {
    const items = [
      item({ at: "2026-11-10T23:38:13Z", source: "console" }),
      item({ at: "2026-11-10T23:30:00Z" }),
      item({ at: "2026-11-10T23:20:00Z" }),
      item({ at: "2026-11-10T23:00:00Z" }),
    ];
    const { days } = buildFeed(items, opts);
    expect(days[0]!.entries.map((e) => e.kind)).toEqual(["single", "single", "single", "single"]);
  });

  it("groups by asset type when changes have no parent", () => {
    const skills = [0, 1, 2].map((n) => item({ at: `2026-11-10T20:0${n}:00Z`, assetType: "skill", parentName: null, parentAssetId: null }));
    const { days } = buildFeed(skills, opts);
    const g = days[0]!.entries[0]!;
    expect(g.kind === "group" && g.title).toBe("3 changes to skills");
  });

  it("adds day headers in the viewer's zone and stops at the limit", () => {
    const items = [
      item({ at: "2026-11-11T02:00:00Z", source: "console" }), // Nov 10 in Los Angeles
      item({ at: "2026-11-10T20:00:00Z", source: "cli" }),
      item({ at: "2026-11-07T18:00:00Z", source: "unknown" }),
    ];
    const { days, truncated } = buildFeed(items, { ...opts, limit: 2 });
    expect(days.map((d) => d.day)).toEqual(["2026-11-10"]);
    expect(days[0]!.entries).toHaveLength(2);
    expect(truncated).toBe(true);
    expect(buildFeed(items, { ...opts, timeZone: "UTC" }).days.map((d) => d.day)).toEqual(["2026-11-11", "2026-11-10", "2026-11-07"]);
  });

  it("writes the detail line by source", () => {
    const console = item({ at: "2026-11-10T23:38:13Z", source: "console", principal: "alex-Admin", name: "overview" });
    expect(describeChange(console, terms, "Operator Web App")).toBe("Memory in chat-tool-use-best-practices · content updated by alex-Admin in the Operator Web App");
    const roleId = item({ at: "2026-11-10T23:38:13Z", source: "console", principal: "AROAEXAMPLEROLEID1234-alex-Admin", name: "overview" });
    expect(describeChange(roleId, terms, "Operator Web App")).toBe("Memory in chat-tool-use-best-practices · content updated by alex-Admin in the Operator Web App");
    const agent = item({ at: "2026-11-10T23:00:38Z", kind: "created", parentName: "verity" });
    expect(describeChange(agent, terms, "DevOps Agent")).toBe("Memory in verity · created by the DevOps Agent");
    expect(describeChange(item({ at: "2026-11-10T23:00:38Z" }), terms, "DevOps Agent")).toBe("Memory in chat-tool-use-best-practices · content updated by the DevOps Agent");
    const reasoned = item({ at: "2026-11-10T23:00:38Z", source: "unknown", kind: "baseline", version: 7, reason: "Imported", parentName: null, assetType: "skill" });
    expect(describeChange(reasoned, terms, "Unknown")).toBe("Skill · first recorded at v7 · Reason: Imported");
  });
});

describe("status words", () => {
  const err = (code: string) => ({ level: "error" as const, code, message: code });
  const warn = (code: string) => ({ level: "warning" as const, code, message: code });

  it("summarizes validation: errors win, then warnings, else Passed; null is Not checked", () => {
    expect(validationStatus([])).toEqual(STATUS.passed);
    expect(validationStatus(null)).toEqual(STATUS.notChecked);
    expect(validationStatus([warn("a")])).toMatchObject({ tone: "warning", label: "1 warning" });
    expect(validationStatus([warn("a"), warn("b")]).label).toBe("2 warnings");
    expect(validationStatus([warn("a"), err("b")])).toMatchObject({ tone: "destructive", label: "1 error" });
    expect(validationStatus([err("a"), err("b"), warn("c")]).label).toBe("2 errors");
  });

  it("sorts errors first and keeps order within a level", () => {
    expect(sortValidation([warn("w1"), err("e1"), warn("w2"), err("e2")]).map((r) => r.code)).toEqual(["e1", "e2", "w1", "w2"]);
  });

  it("maps every change word to a tone, an icon and a label", () => {
    const words = ["create", "update-content", "set-inactive", "skip-live-changed", "no-change", "delete", "unchanged", "added", "removed", "metadata-only"] as const;
    for (const w of words) {
      expect(CHANGE_WORDS[w].label, w).toBeTruthy();
      expect(CHANGE_WORDS[w].icon, w).toBeTruthy();
    }
    expect(CHANGE_WORDS["update-content"]).toMatchObject({ tone: "info", label: "Update content" });
    expect(CHANGE_WORDS["set-inactive"]).toMatchObject({ tone: "agent", label: "Set Inactive" });
    expect(CHANGE_WORDS["skip-live-changed"]).toMatchObject({ tone: "warning", label: "Skip: live changed" });
    expect(CHANGE_WORDS["no-change"].tone).toBe("muted");
  });

  it("uses one set of connection words, a rejected test reading as failed", () => {
    expect(["ok", "failed", "rejected", "unknown"].map((s) => connectionStatusSpec(s).label)).toEqual(["Connected", "Connection failed", "Connection failed", "Not tested"]);
  });

  it("uses the MASTER words for plan states", () => {
    expect([STATUS.waitingForApproval, STATUS.applying, STATUS.applied, STATUS.failed].map((s) => [s.tone, s.label])).toEqual([
      ["warning", "Waiting for approval"],
      ["info", "Applying"],
      ["success", "Applied"],
      ["destructive", "Failed"],
    ]);
  });
});

describe("planned features", () => {
  it("labels later-phase features Planned, with the phase only in the tooltip", () => {
    const html = renderToStaticMarkup(createElement(PhaseBadge, { phase: 3 }));
    expect(html).toContain(">Planned</span>");
    expect(html).toContain('title="Planned for phase 3"');
    expect(html).not.toContain("Phase 3");
  });

  it("says what the page will do, then that it isn't built yet", () => {
    expect(phasePlaceholderText("An audit runs investigations.")).toEqual({ title: "An audit runs investigations.", body: "This part of the app isn't built yet." });
  });
});

describe("connection next step", () => {
  const html = (canManage: boolean, onSettingsPage = false) => renderToStaticMarkup(createElement(ConnectionNextStep, { alias: "demo space", canManage, onSettingsPage }));

  it("links Space settings for Admins, and an Admin to the roles page for everyone else", () => {
    expect(html(true)).toBe('An Admin sets the connection in <a class="font-medium underline underline-offset-4" href="/spaces/demo%20space/settings">Space settings</a>.');
    expect(html(false)).toBe('Ask <a class="font-medium underline underline-offset-4" href="/spaces/demo%20space/roles">an Admin</a> to check the connection in Space settings.');
    expect(html(true, true)).not.toContain("<a");
  });
});
