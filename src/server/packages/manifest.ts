import { z } from "zod";

/**
 * The optional package manifest (layout `manifest`): metadata the package
 * files can't carry, such as a skill's agent types or a status, keyed by
 * asset type and identity. Written on export, read on import. Files win
 * over the manifest when both give a value.
 */
export const packageManifestSchema = z.object({
  layout: z.string().optional(),
  assets: z.array(
    z.object({
      assetType: z.string(),
      key: z.string(),
      metadata: z.record(z.string(), z.unknown()).default({}),
    }),
  ),
});

export type PackageManifest = z.output<typeof packageManifestSchema>;

export function parseManifest(text: string): { manifest: PackageManifest | null; error?: string } {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (e) {
    return { manifest: null, error: (e as Error).message };
  }
  const parsed = packageManifestSchema.safeParse(raw);
  if (!parsed.success) return { manifest: null, error: parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ") };
  return { manifest: parsed.data };
}

export function manifestMetadata(manifest: PackageManifest | null, assetType: string, key: string): Record<string, unknown> {
  return manifest?.assets.find((a) => a.assetType === assetType && a.key === key)?.metadata ?? {};
}

export function renderManifest(manifest: PackageManifest): string {
  return `${JSON.stringify(manifest, null, 2)}\n`;
}
