/**
 * Text helpers. Package files are bytes; a file is text when it is valid
 * UTF-8 without NUL bytes.
 */

const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

/** Decode valid UTF-8 text, or null for binary content. */
export function decodeText(bytes: Uint8Array): string | null {
  if (bytes.includes(0)) return null;
  try {
    return decoder.decode(bytes);
  } catch {
    return null;
  }
}

export function isText(bytes: Uint8Array): boolean {
  return decodeText(bytes) !== null;
}

/**
 * What Python's Path.read_text() returns: UTF-8 with universal newlines
 * ("\r\n" and "\r" become "\n"). Used where ported tools must match byte for byte.
 */
export function pythonReadText(bytes: Uint8Array): string {
  const text = new TextDecoder("utf-8", { ignoreBOM: true }).decode(bytes);
  return text.replace(/\r\n?/g, "\n");
}

export function utf8(text: string): Buffer {
  return Buffer.from(text, "utf8");
}

/**
 * Python's json.dumps(value, indent=2) with the default ensure_ascii: the same
 * layout as JSON.stringify(value, null, 2), with every non-ASCII character
 * (and DEL) escaped as \uXXXX.
 */
export function pythonJsonDumps(value: unknown): string {
  return JSON.stringify(value, null, 2).replace(/[\u007f-\uffff]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`);
}

/** Python str.splitlines() separators. */
const SPLITLINES = /\r\n|[\n\r\u000b\u000c\u001c\u001d\u001e\u0085\u2028\u2029]/;

export function pythonSplitlines(text: string): string[] {
  if (!text) return [];
  const lines = text.split(SPLITLINES);
  // A trailing separator does not start another line
  if (lines[lines.length - 1] === "") lines.pop();
  return lines;
}

/** Python str.strip() with no argument: Unicode whitespace on both ends. */
export function pythonStrip(s: string): string {
  return s.replace(/^[\s\u001c-\u001f\u0085]+|[\s\u001c-\u001f\u0085]+$/gu, "");
}

/** Python str.strip(chars). */
export function stripChars(s: string, chars: string): string {
  let a = 0;
  let b = s.length;
  while (a < b && chars.includes(s[a]!)) a++;
  while (b > a && chars.includes(s[b - 1]!)) b--;
  return s.slice(a, b);
}

/** Line count as an editor shows it: a final newline does not start a new line. */
export function lineCount(text: string): number {
  if (!text) return 0;
  const n = text.split("\n").length;
  return text.endsWith("\n") ? n - 1 : n;
}
