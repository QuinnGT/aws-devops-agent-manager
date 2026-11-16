/**
 * Timestamps in markdown exports look like "2026-10-19 07:49:21.523000+00:00"
 * (microseconds, explicit offset) or "2026-10-19 07:49:21+00:00". Times
 * without an offset are UTC. JavaScript dates hold milliseconds, so digits
 * after the third fractional digit are dropped and reported.
 */
const TS = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})(?:\.(\d+))?(Z|[+-]\d{2}:?\d{2})?$/;

export interface ParsedTimestamp {
  date: Date;
  /** True when the source had non-zero digits below one millisecond */
  subMillisecondDropped: boolean;
}

export function parseExportTimestamp(input: string): ParsedTimestamp | null {
  const m = TS.exec(input.trim());
  if (!m) return null;
  const [, y, mo, d, h, mi, s, frac = "", off] = m;
  const ms = Number((frac + "000").slice(0, 3));
  let t = Date.UTC(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi), Number(s), ms);
  if (off && off !== "Z") {
    const sign = off.startsWith("-") ? -1 : 1;
    const digits = off.slice(1).replace(":", "");
    const minutes = Number(digits.slice(0, 2)) * 60 + Number(digits.slice(2, 4));
    t -= sign * minutes * 60_000;
  }
  const date = new Date(t);
  if (Number.isNaN(date.getTime())) return null;
  return { date, subMillisecondDropped: /[1-9]/.test(frac.slice(3)) };
}
