import { describe, expect, it } from "vitest";
import { getAppPolicy } from "@/server/policy";
import { packageIoSection } from "@/server/policy/sections/package-io";
import { PERMISSIONS } from "@/server/policy/sections/roles";
import { PACKAGE_IO_PERMISSIONS } from "./types";

describe("package-io.yaml", () => {
  it("loads the shipped defaults", () => {
    const p = getAppPolicy().policy.packageIo;
    expect(p.uploads.retentionDays).toBe(30);
    expect(p.import.blockPlanOnErrors).toBe(true);
    expect(p.export.packageName).toBe("{spaceAlias}-{ref}");
    expect(p.export.blockOnFailedChecks).toBe(false);
    expect(p.export.notes.path).toBe("reference/EXPORT-NOTES.md");
  });

  it("names a known permission for each entry point; export needs history.read", () => {
    expect(PACKAGE_IO_PERMISSIONS).toEqual({ import: "plans.create", plan: "plans.create", read: "assets.read", export: "history.read" });
    for (const p of Object.values(PACKAGE_IO_PERMISSIONS)) expect(PERMISSIONS).toContain(p);
  });

  it("fills every key when the file is empty", () => {
    expect(packageIoSection.schema.parse({})).toEqual(getAppPolicy().policy.packageIo);
  });

  it("rejects templates with unknown placeholders", () => {
    expect(packageIoSection.schema.safeParse({ export: { packageName: "{spaceAlias}-{branch}" } }).success).toBe(false);
    expect(packageIoSection.schema.safeParse({ import: { planTitle: "Import {fileName} into {spaceAlias}" } }).success).toBe(true);
    expect(packageIoSection.schema.safeParse({ uploads: { retentionDays: 0 } }).success).toBe(false);
  });
});
