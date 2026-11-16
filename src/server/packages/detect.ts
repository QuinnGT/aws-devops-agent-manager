import type { Policy } from "@/server/policy";
import { packageToDesiredAssets } from "./desired";
import type { PackageContents } from "./types";

/**
 * Layout detection: map a package with every layout in policy and rank
 * them. The best layout maps the most files to assets; ties go to the one
 * that leaves fewer files unmapped, then to the default layout, then to the
 * order in package-layouts.yaml. Pure.
 */

export interface LayoutFit {
  layout: string;
  label: string;
  /** Package assets the layout finds */
  assets: number;
  /** Files that belong to an asset */
  assetFiles: number;
  /** Files no rule of the layout claims */
  unmappedFiles: number;
}

export function rankLayouts(contents: PackageContents, policy: Policy): LayoutFit[] {
  const layouts = Object.values(policy.packageLayouts.layouts);
  const fits = layouts.map((layout, order) => {
    const mapped = packageToDesiredAssets(contents, layout, { policy });
    let assetFiles = 0;
    let unmappedFiles = 0;
    for (const r of mapped.roles.values()) {
      if (r.role === "asset") assetFiles++;
      else if (r.role === "unmapped") unmappedFiles++;
    }
    const fit: LayoutFit = { layout: layout.name, label: layout.label, assets: mapped.assets.length, assetFiles, unmappedFiles };
    return { fit, order, isDefault: layout.name === policy.packageLayouts.defaultLayout };
  });
  fits.sort((a, b) => b.fit.assetFiles - a.fit.assetFiles || a.fit.unmappedFiles - b.fit.unmappedFiles || Number(b.isDefault) - Number(a.isDefault) || a.order - b.order);
  return fits.map((f) => f.fit);
}
