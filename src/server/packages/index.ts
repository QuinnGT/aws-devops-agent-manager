/**
 * Package tools: read a package folder or zip, map it to desired assets with
 * a layout from policy/package-layouts.yaml, build it (shared sections,
 * indexes, skill zips, checks) and export desired assets back to a package
 * zip. Pure libraries: no AWS calls, no database. See README.md.
 */
export * from "./types";
export { readPackage, readPackageFolder, readPackageZip, readPackageFiles, packageFromFiles, clonePackage, normalizePackage } from "./read";
export type { PackageInput, ReadPackageOptions } from "./read";
export { getLayout, listLayouts, agentTypeResolver, type PackageLayout } from "./layout";
export { packageToDesiredAssets, packageToPackageFiles, type MappedPackage, type FileRole, type MapOptions } from "./desired";
export { desiredAssetsToPackage, exportPackageZip, type ExportOptions, type ExportResult } from "./export";
export { buildRelease, zipPackage, type BuildOptions, type BuildResult } from "./build";
export { checkPackage, isAbout, withoutFailingAssets, type CheckPackageOptions, type FailingAsset, type PackageCheck } from "./check";
export { targetPackageAssets, type LeftOutAsset, type LeftOutReason, type TargetedPackage, type TargetOptions } from "./target";
export { rankLayouts, type LayoutFit } from "./detect";
export { listAssetFolders, parseDescriptor, type AssetFolder, type AssetDescriptor } from "./asset-folders";
export { snapshotsToDesiredAssets, snapshotsToLiveRefs } from "./live";
export { readZip, writeZip, type ZipEntry, type ZipReadLimits } from "./zip";
export { parseFrontmatter, renderFrontmatter } from "./frontmatter";
export { assetIdentity } from "@/server/validation/identity";
