/**
 * Links for asset and history pages. Times use the shared Time component
 * (viewer's time zone), so this file only builds URLs.
 */
export function spaceHref(alias: string, sub = ""): string {
  return `/spaces/${encodeURIComponent(alias)}${sub}`;
}

export function assetHref(alias: string, assetId: string): string {
  return spaceHref(alias, `/assets/${encodeURIComponent(assetId)}`);
}

/** The asset page on one tab (pages/asset-detail.md: tabs live in ?tab=). */
export function assetTabHref(alias: string, assetId: string, tab: "content" | "versions" | "metadata" | "files", extra: Record<string, string> = {}): string {
  const q = new URLSearchParams(tab === "content" ? extra : { tab, ...extra });
  const s = q.toString();
  return s ? `${assetHref(alias, assetId)}?${s}` : assetHref(alias, assetId);
}

/** An asset's history: the Versions tab of its page. */
export function historyHref(alias: string, assetId: string): string {
  return assetTabHref(alias, assetId, "versions");
}

/** Compare two recorded versions. `from` and `to` are version numbers or commit hashes. */
export function diffHref(alias: string, assetId: string, from: string, to: string): string {
  return assetTabHref(alias, assetId, "versions", { from, to });
}

export function fileDownloadHref(alias: string, assetId: string, path: string, commit?: string): string {
  const q = new URLSearchParams({ path });
  if (commit) q.set("commit", commit);
  return `/api/spaces/${encodeURIComponent(alias)}/assets/${encodeURIComponent(assetId)}/file?${q.toString()}`;
}

/** The restore confirmation: "Create a plan to restore overview to v13?" */
export function restoreConfirm(name: string, version: number): { title: string; body: string; label: string } {
  return { title: `Create a plan to restore ${name} to v${version}?`, body: "Nothing changes in the space until the plan is applied.", label: "Create plan" };
}
