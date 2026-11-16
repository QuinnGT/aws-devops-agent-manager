import type { ManifestAsset } from "@/server/releases/manifest";
import { releaseAnchor } from "@/server/releases/views";
import type { VerifyPolicy } from "@/server/policy/sections/verify";

/**
 * Which investigations ran on a release (policy verify.reads.window). Pure.
 *
 *   release-created  from the release's creation to the next release's creation
 *   content-live     from the newest asset change in the release (its manifest
 *                    anchor) to the newest asset change in the next release, when
 *                    that is later; a next release with the same anchor changed
 *                    nothing, so the window stays open
 */

export interface ReleaseTimes {
  name: string;
  createdAt: Date;
  assets: readonly Pick<ManifestAsset, "serviceUpdatedAt">[];
}

export interface ReadsWindow {
  mode: VerifyPolicy["reads"]["window"];
  from: Date;
  to: Date | null;
  nextRelease: string | null;
}

export function readsWindow(release: ReleaseTimes, next: ReleaseTimes | null, mode: VerifyPolicy["reads"]["window"]): ReadsWindow {
  if (mode === "content-live") {
    const from = releaseAnchor(release.assets) ?? release.createdAt;
    const nextAnchor = next ? releaseAnchor(next.assets) : null;
    const to = nextAnchor && nextAnchor.getTime() > from.getTime() ? nextAnchor : null;
    return { mode, from, to, nextRelease: to ? (next?.name ?? null) : null };
  }
  return { mode, from: release.createdAt, to: next?.createdAt ?? null, nextRelease: next?.name ?? null };
}
