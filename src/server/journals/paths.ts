import { mkdirSync } from "node:fs";
import path from "node:path";
import { env } from "@/server/env";

/** Export and import files live under DAM_DATA_DIR. Stored paths are relative to these directories. */

export type DataArea = "exports" | "imports";

export function areaDir(area: DataArea): string {
  return path.join(/*turbopackIgnore: true*/ env().dataDir, area);
}

export function ensureAreaDir(area: DataArea): string {
  const dir = areaDir(area);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  return dir;
}

/** Resolve a stored relative path, refusing anything that would leave the area directory. */
export function resolveInArea(area: DataArea, rel: string): string {
  const base = areaDir(area);
  if (!rel || path.isAbsolute(rel) || rel.split(/[\\/]/).includes("..")) throw new Error(`invalid stored path: ${rel}`);
  const abs = path.resolve(base, rel);
  if (abs !== base && !abs.startsWith(base + path.sep)) throw new Error(`invalid stored path: ${rel}`);
  return abs;
}

/** A file name safe to use on disk and in a Content-Disposition header. */
export function safeFileName(name: string, fallback = "file"): string {
  const base = name.split(/[\\/]/).pop() ?? "";
  const cleaned = base
    .normalize("NFKC")
    .replace(/[^\w.@+-]+/g, "_")
    .replace(/^[._]+/, "")
    .slice(0, 120);
  return cleaned || fallback;
}
