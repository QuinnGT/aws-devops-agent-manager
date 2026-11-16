/**
 * clientToken for apply's write calls: each write uses the plan entry ID as
 * its clientToken, so a retried job cannot apply the same change twice.
 *
 * The API reference gives clientToken a length of 1 to 128 characters and no
 * pattern (CreateAsset, UpdateAsset, CreateAssetFile, UpdateAssetFile); the
 * SDK model marks it as an idempotency token. A plan item ID is a UUID (36
 * characters of [0-9a-f-]). The first call of an item uses the ID itself;
 * an item that needs several calls (per-file writes) adds "-<n>" for the
 * n-th call, so every call has its own stable token and the item stays
 * recognizable in CloudTrail. DeleteAssetFile and DeleteAsset take no token.
 */

const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
const TOKEN = new RegExp(`^(${UUID})(?:-([1-9][0-9]{0,3}))?$`, "i");

export const CLIENT_TOKEN_MAX_LENGTH = 128;

/** Token of the step at `index` (0-based) of a plan item. */
export function clientTokenFor(planItemId: string, index: number): string {
  if (!new RegExp(`^${UUID}$`, "i").test(planItemId)) throw new Error(`plan item ID is not a UUID: ${planItemId}`);
  if (!Number.isInteger(index) || index < 0 || index > 9999) throw new Error(`step index out of range: ${index}`);
  const token = index === 0 ? planItemId : `${planItemId}-${index}`;
  return token.toLowerCase();
}

/** The plan item ID and step index of a token this app issued, or null. */
export function parseClientToken(token: string): { planItemId: string; index: number } | null {
  if (token.length > CLIENT_TOKEN_MAX_LENGTH) return null;
  const m = TOKEN.exec(token);
  if (!m) return null;
  return { planItemId: m[1]!.toLowerCase(), index: m[2] ? Number(m[2]) : 0 };
}
