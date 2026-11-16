import { z } from "zod";
import type { CreateImportPlanOptions, ExportPackageRequest, ImportPackageRequest } from "./service";
import { PackageIoError } from "./types";

/**
 * Input parsing for the Server Actions and the download Route
 * Handler, so they stay thin: DAL check, parse here, call the service.
 * Paths and sizes are not checked here; the package reader does that.
 */

const optionalText = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .optional()
    .transform((v) => (v ? v : undefined));

const layoutName = optionalText(100);

/**
 * The upload form. A zip: one file in `file`. A folder: the files in `files`
 * and, in the same order, each file's relative path in `paths` (the
 * browser's webkitRelativePath, because a File's own name has no folders).
 */
export async function importRequestFromForm(form: FormData): Promise<ImportPackageRequest> {
  const layout = layoutName.safeParse(form.get("layout") ?? undefined);
  if (!layout.success) throw new PackageIoError("bad-request", "The layout name is not valid.");
  const file = form.get("file");
  const files = form.getAll("files").filter((f): f is File => f instanceof File);
  if (file instanceof File && file.size > 0) {
    return { layout: layout.data, upload: { kind: "zip", fileName: file.name, bytes: Buffer.from(await file.arrayBuffer()) } };
  }
  if (files.length === 0) throw new PackageIoError("bad-request", "Choose a package zip or a package folder.");
  const paths = form.getAll("paths").map(String);
  if (paths.length !== files.length) throw new PackageIoError("bad-request", "Each uploaded file needs its path in the folder.");
  const name = optionalText(200).safeParse(form.get("name") ?? undefined);
  return {
    layout: layout.data,
    upload: {
      kind: "folder",
      ...(name.success && name.data ? { name: name.data } : {}),
      files: await Promise.all(files.map(async (f, i) => ({ path: paths[i]!, data: Buffer.from(await f.arrayBuffer()) }))),
    },
  };
}

const assetTypeName = z.string().trim().regex(/^[a-z][a-z0-9_]{0,63}$/);

/**
 * "Create plan" form: the import ID, an optional plan title, an optional
 * change reason and, when the form offers the choice (`typeSelection` is
 * set), the asset types to include as `types` (one value per checked type).
 */
export const createPlanFormSchema = z.object({
  importId: z.uuid(),
  title: optionalText(200),
  reason: optionalText(2000),
  types: z.array(assetTypeName).max(50).optional(),
});

export function createPlanRequestFromForm(form: FormData): { importId: string; options: CreateImportPlanOptions } {
  const offered = form.get("typeSelection") !== null;
  const r = createPlanFormSchema.safeParse({
    importId: form.get("importId") ?? "",
    title: form.get("title") ?? undefined,
    reason: form.get("reason") ?? undefined,
    types: offered ? form.getAll("types").map(String) : undefined,
  });
  if (!r.success) throw new PackageIoError("bad-request", "The import, the title, the reason or the asset types are not valid. Titles are up to 200 characters.");
  if (offered && !r.data.types?.length) throw new PackageIoError("bad-request", "Choose at least one asset type to import.");
  return { importId: r.data.importId, options: { title: r.data.title ?? null, reason: r.data.reason ?? null, ...(offered ? { includeTypes: r.data.types! } : {}) } };
}

/** "Read with another layout": the import ID and a layout name from package-layouts.yaml. */
export function layoutRequestFromForm(form: FormData): { importId: string; layout: string } {
  const r = z.object({ importId: z.uuid(), layout: z.string().trim().min(1).max(100) }).safeParse({ importId: form.get("importId") ?? "", layout: form.get("layout") ?? "" });
  if (!r.success) throw new PackageIoError("bad-request", "Choose a layout from the list.");
  return r.data;
}

/** Download query string: `?ref=<HEAD | commit | release tag>&layout=<name>&name=<package name>`. */
export const exportQuerySchema = z.object({
  ref: optionalText(255),
  layout: layoutName,
  name: optionalText(120),
});

export function exportRequestFromSearchParams(params: URLSearchParams): ExportPackageRequest {
  const r = exportQuerySchema.safeParse({ ref: params.get("ref") ?? undefined, layout: params.get("layout") ?? undefined, name: params.get("name") ?? undefined });
  if (!r.success) throw new PackageIoError("bad-request", "The export point, the layout or the package name is not valid.");
  return { ref: r.data.ref ?? null, layout: r.data.layout ?? null, name: r.data.name ?? null };
}
