/**
 * Small helpers that reproduce Python behavior the reference audit scripts
 * rely on, so analyzer output matches their JSON field by field.
 */

const WORD = "\\p{L}\\p{N}_";
const B = `(?:(?<=[${WORD}])(?![${WORD}])|(?<![${WORD}])(?=[${WORD}]))`;

/**
 * Compiles a Python `re` pattern as a JavaScript RegExp with the "u" flag.
 * Python 3 str patterns treat \b, \d and \w as Unicode-aware (an accented
 * letter is a word character); JavaScript does not, so those escapes are
 * rewritten. \Z becomes end of input. Flags: i, m, s, g, y.
 */
export function pyRegex(source: string, flags = ""): RegExp {
  let out = "";
  let inClass = false;
  for (let i = 0; i < source.length; i++) {
    const c = source[i]!;
    if (c === "\\") {
      const n = source[i + 1] ?? "";
      i++;
      if (n === "b" && !inClass) out += B;
      else if (n === "d") out += "\\p{Nd}";
      else if (n === "w") out += inClass ? WORD : `[${WORD}]`;
      else if (n === "Z" && !inClass) out += "(?![\\s\\S])";
      else if (n === "-" && !inClass) out += "-";
      else out += `\\${n}`;
      continue;
    }
    if (c === "[" && !inClass) inClass = true;
    else if (c === "]" && inClass) inClass = false;
    out += c;
  }
  return new RegExp(out, flags.includes("u") ? flags : `${flags}u`);
}

/**
 * Python's round(x, ndigits): correctly rounded on the exact binary value,
 * with ties going to the even digit. Number#toFixed also rounds the exact
 * value but sends ties away from zero, so exact ties are corrected here.
 */
export function pyRound(x: number, ndigits: number): number {
  if (!Number.isFinite(x)) return x;
  const rounded = Number(x.toFixed(ndigits));
  const exact = Math.abs(x).toFixed(100);
  const [ip = "0", fp = ""] = exact.split(".");
  const tail = fp.slice(ndigits);
  const isTie = tail[0] === "5" && /^0*$/.test(tail.slice(1));
  if (!isTie) return rounded;
  const kept = ip + fp.slice(0, ndigits);
  const lastDigit = Number(kept[kept.length - 1]);
  if (lastDigit % 2 !== 0) return rounded;
  const truncated = Number(`${ip}${ndigits ? `.${fp.slice(0, ndigits)}` : ""}`);
  return x < 0 ? -truncated : truncated;
}

/** Minutes between two dates, rounded like Python's round(seconds / 60, 1). */
export function minutesBetween(a: Date, b: Date): number {
  return pyRound((b.getTime() - a.getTime()) / 1000 / 60, 1);
}
