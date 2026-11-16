/**
 * Path rules for package files and zip entries. Package paths are relative,
 * use forward slashes, and have no empty, "." or ".." segments.
 */

export type PathProblem = "empty" | "absolute" | "parent-segment" | "backslash" | "control-character" | "empty-segment" | "dot-segment" | "too-long";

const PROBLEM_TEXT: Record<PathProblem, string> = {
  empty: "is empty",
  absolute: "is an absolute path",
  "parent-segment": "contains a '..' segment",
  backslash: "contains a backslash",
  "control-character": "contains a control character",
  "empty-segment": "contains an empty segment ('//')",
  "dot-segment": "contains a '.' segment",
  "too-long": "is too long",
};

export function describePathProblem(p: PathProblem): string {
  return PROBLEM_TEXT[p];
}

/**
 * Check a package or zip entry path. A trailing "/" (a directory entry) is
 * allowed and ignored. Returns the problem, or null when the path is safe.
 */
export function pathProblem(raw: string, maxLength = 4096): PathProblem | null {
  if (!raw) return "empty";
  if (raw.length > maxLength) return "too-long";
  if (/[\u0000-\u001f\u007f]/.test(raw)) return "control-character";
  if (raw.includes("\\")) return "backslash";
  if (raw.startsWith("/") || /^[A-Za-z]:/.test(raw)) return "absolute";
  const trimmed = raw.endsWith("/") ? raw.slice(0, -1) : raw;
  if (!trimmed) return "empty";
  const parts = trimmed.split("/");
  if (parts.includes("..")) return "parent-segment";
  if (parts.includes("")) return "empty-segment";
  if (parts.includes(".")) return "dot-segment";
  return null;
}

export function isSafeRelativePath(raw: string, maxLength?: number): boolean {
  return pathProblem(raw, maxLength) === null;
}

const globCache = new Map<string, RegExp>();

/** Glob to RegExp: `**` any number of segments, `*` within a segment, `?` one character. */
export function globToRegExp(glob: string): RegExp {
  let re = globCache.get(glob);
  if (re) return re;
  let out = "^";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i]!;
    if (c === "*") {
      if (glob[i + 1] === "*") {
        const atSegmentStart = i === 0 || glob[i - 1] === "/";
        const followedBySlash = glob[i + 2] === "/";
        if (atSegmentStart && followedBySlash) {
          out += "(?:[^/]*/)*";
          i += 2;
        } else {
          out += ".*";
          i += 1;
        }
      } else out += "[^/]*";
    } else if (c === "?") out += "[^/]";
    else out += c.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  }
  out += "$";
  re = new RegExp(out, "u");
  globCache.set(glob, re);
  return re;
}

export function matchesGlob(path: string, glob: string): boolean {
  return globToRegExp(glob).test(path);
}

export function matchesAny(path: string, globs: readonly string[]): boolean {
  return globs.some((g) => matchesGlob(path, g));
}

function compareCodePoints(a: string, b: string): number {
  const ai = a[Symbol.iterator]();
  const bi = b[Symbol.iterator]();
  for (;;) {
    const x = ai.next();
    const y = bi.next();
    if (x.done || y.done) return x.done && y.done ? 0 : x.done ? -1 : 1;
    const d = x.value.codePointAt(0)! - y.value.codePointAt(0)!;
    if (d) return d;
  }
}

/**
 * Order paths the way Python's sorted(Path.rglob(...)) does: segment by
 * segment, by code point, a prefix first. Keeps ported output identical.
 */
export function comparePaths(a: string, b: string): number {
  const ap = a.split("/");
  const bp = b.split("/");
  const n = Math.min(ap.length, bp.length);
  for (let i = 0; i < n; i++) {
    const d = compareCodePoints(ap[i]!, bp[i]!);
    if (d) return d;
  }
  return ap.length - bp.length;
}

export function sortPaths(paths: Iterable<string>): string[] {
  return [...paths].sort(comparePaths);
}

/** Join and normalize "." and ".." lexically. Returns null when it climbs above the root. */
export function resolveRelative(baseDir: string, target: string): string | null {
  if (target.startsWith("/")) return null;
  const parts = baseDir.split("/").filter(Boolean);
  for (const seg of target.split("/")) {
    if (!seg || seg === ".") continue;
    if (seg === "..") {
      if (!parts.length) return null;
      parts.pop();
    } else parts.push(seg);
  }
  return parts.join("/");
}

export function dirname(p: string): string {
  const i = p.lastIndexOf("/");
  return i < 0 ? "" : p.slice(0, i);
}

export function basename(p: string): string {
  return p.slice(p.lastIndexOf("/") + 1);
}

/** Python Path.stem: the name without its last suffix (".md"). */
export function stem(p: string): string {
  const name = basename(p);
  const i = name.lastIndexOf(".");
  return i > 0 ? name.slice(0, i) : name;
}

/** Replace {key} placeholders. Throws when a placeholder has no value. */
export function fill(template: string, values: Record<string, string>): string {
  return template.replace(/\{(\w+)\}/g, (_, key: string) => {
    const v = values[key];
    if (v === undefined) throw new Error(`template ${template} needs {${key}}`);
    return v;
  });
}
