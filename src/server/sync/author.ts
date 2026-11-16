import type { Attribution } from "@/server/attribution";
import type { CommitAuthor } from "@/server/git/history-repo";
import type { Policy } from "@/server/policy";
import { sha256Hex } from "./content";

/** Attribution used when attributeChanges fails or returns nothing for a change. */
export function fallbackAttribution(labels: Policy["attribution"]["labels"], matchedBy: "error" | "none"): Attribution {
  return { source: "unknown", label: labels.unknown, principal: null, cloudTrailEventId: null, planId: null, matchedBy };
}

const EMAIL = /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/;

function cleanName(s: string): string {
  return s.replace(/[<>\r\n]/g, "").trim();
}

/** Lowercase, path-free slug for the local part of a synthetic email. */
export function principalSlug(s: string): string {
  const slug = s
    .toLowerCase()
    .replace(/[^a-z0-9._+-]+/g, "-")
    .replace(/^[-.]+|[-.]+$/g, "")
    .replace(/\.{2,}/g, ".");
  if (!slug) return "unknown";
  return slug.length <= 64 ? slug : `${slug.slice(0, 55).replace(/[-.]+$/, "")}-${sha256Hex(s).slice(0, 8)}`;
}

/**
 * Git author for an attributed change: the principal (or the source label when
 * there is none), with the principal's own email when it is one, otherwise a
 * synthetic `<slug>@<domain>`.
 */
export function authorFor(a: Attribution, syntheticEmailDomain: string): CommitAuthor {
  const principal = a.principal ? cleanName(a.principal) : "";
  const name = principal || cleanName(a.label) || "Unknown";
  if (principal && EMAIL.test(principal)) return { name, email: principal };
  return { name, email: `${principalSlug(principal || a.source)}@${syntheticEmailDomain}` };
}
