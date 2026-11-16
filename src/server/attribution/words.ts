/**
 * Why changes are marked Unknown, in plain words for Home's "Who made
 * changes" card. Each reason is said only when it applies, so the 90-day
 * sentence never sits next to changes made today. Pure.
 */

export interface UnknownReasons {
  /** Older than the CloudTrail lookup period */
  old: number;
  /** Recent; the CloudTrail event may not be delivered yet */
  pending: number;
  /** The CloudTrail lookup failed */
  failed: number;
  /** CloudTrail had no matching event */
  noEvent: number;
}

const changes = (n: number) => `${n} ${n === 1 ? "change" : "changes"}`;

/** One sentence per reason that applies, most common first; empty when nothing is Unknown. */
export function unknownReasonText(r: UnknownReasons, o: { retentionDays: number; deliveryDelaySeconds: number }): string[] {
  const { retentionDays } = o;
  const wait = Math.max(1, Math.round(o.deliveryDelaySeconds / 60));
  const parts: { n: number; text: string }[] = [];
  if (r.old > 0) {
    parts.push({
      n: r.old,
      text: `AWS keeps a record of who made each change for ${retentionDays} days. ${changes(r.old)} marked Unknown ${r.old === 1 ? "is" : "are"} older than that.`,
    });
  }
  if (r.pending > 0) {
    parts.push({
      n: r.pending,
      text: `CloudTrail hasn't delivered an event yet for ${changes(r.pending)} made recently. The app waits ${wait} ${wait === 1 ? "minute" : "minutes"} for one, and a later sync looks again.`,
    });
  }
  if (r.noEvent > 0) parts.push({ n: r.noEvent, text: `CloudTrail had no matching event for ${changes(r.noEvent)}.` });
  if (r.failed > 0) parts.push({ n: r.failed, text: `The CloudTrail lookup failed for ${changes(r.failed)}.` });
  return parts.sort((a, b) => b.n - a.n).map((p) => p.text);
}
