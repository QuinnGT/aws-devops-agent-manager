import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { DesiredAsset, DesiredFile } from "@/server/packages/types";
import { getAppPolicy, type Policy } from "@/server/policy";
import { validateDraftAsset } from "./asset";
import type { ValidationResult } from "./types";

const policy = getAppPolicy().policy;
const md = (path: string, content: string): DesiredFile => ({ path, encoding: "utf8", content });
const SKILL_FM = "---\nname: rds-check\ndescription: Use for RDS checks.\n---\n# RDS\n";

function asset(assetType: string, metadata: Record<string, unknown>, files: DesiredFile[], extra: Partial<DesiredAsset> = {}): DesiredAsset {
  return { assetType, key: String(metadata.name ?? metadata.agent_type ?? "k"), metadata, files, ...extra };
}
const skill = (metadata: Record<string, unknown> = {}, files: DesiredFile[] = [md("SKILL.md", "# RDS\n")], extra: Partial<DesiredAsset> = {}) =>
  asset("skill", { name: "rds-check", description: "Use for RDS checks.", agent_types: ["GENERIC"], ...metadata }, files, extra);
const run = (a: DesiredAsset, p: Policy = policy, previous?: { metadata: Record<string, unknown> }) => validateDraftAsset(a, { policy: p, previous });
const codes = (r: ValidationResult[]) => r.map((x) => `${x.level} ${x.code}${x.path ? ` ${x.path}` : ""}`);
const errors = (r: ValidationResult[]) => codes(r.filter((x) => x.level === "error"));
const withLimits = (l: Partial<Policy["limits"]>): Policy => ({ ...policy, limits: { ...policy.limits, ...l } });

describe("validateDraftAsset: metadata schemas", () => {
  it("accepts a valid simple skill and a custom agent", () => {
    expect(run(skill())).toEqual([]);
    expect(run(asset("custom_agent", { name: "rds-firefighter", tools: ["rds:DescribeDBInstances"], skills: ["ki-1"] }, [md("AGENT.md", "# A\n")]))).toEqual([]);
  });

  it("rejects GENERIC combined with other agent types on a skill", () => {
    const r = run(skill({ agent_types: ["GENERIC", "CHAT"] }));
    expect(errors(r)).toEqual(["error metadata.schema metadata.agent_types"]);
    expect(r[0]!.message).toMatch(/GENERIC \(all agents\) can't be combined/);
  });

  it("names the bad item for an unknown agent type", () => {
    const r = run(skill({ agent_types: ["INCIDENT_RCA", "FOO"] }));
    expect(errors(r)).toEqual(["error metadata.schema metadata.agent_types[1]"]);
    expect(r[0]!.message).toMatch(/Use one of: GENERIC, CHAT/);
  });

  it("checks name rules, status case, description length and required keys", () => {
    expect(errors(run(skill({ name: "-Bad_Name" })))).toEqual(["error metadata.schema metadata.name"]);
    const status = run(skill({ status: "active" }));
    expect(status[0]!.message).toBe("metadata.status: Use ACTIVE or INACTIVE (uppercase).");
    expect(errors(run(skill({ description: "x".repeat(1025) })))).toEqual(["error metadata.schema metadata.description"]);
    const missing = run(asset("skill", { name: "rds-check", agent_types: ["GENERIC"] }, [md("SKILL.md", "# x\n")]));
    expect(missing.map((x) => x.message)).toEqual(["metadata.description is required. Use 1 to 1024 characters."]);
  });

  it("rejects metadata keys the type's schema doesn't list, because the service drops them", () => {
    const r = run(skill({ probe_note: "x", enable_tools: ["a"] }));
    expect(errors(r)).toEqual(["error metadata.unknown-key metadata.probe_note"]);
    expect(r[0]!.message).toBe("The service doesn't keep metadata.probe_note on this asset type, so it would be dropped when the change is applied. Remove it.");
  });

  it("allows LEARNED only on existing skills", () => {
    expect(errors(run(skill({ skill_type: "LEARNED" })))).toEqual(["error metadata.create metadata.skill_type"]);
    expect(run(skill({ skill_type: "LEARNED" }, undefined, { assetId: "ki-1" }))).toEqual([]);
  });

  it("checks agents_md agent_type, main file and frontmatter", () => {
    expect(errors(run(asset("agents_md", { agent_type: "NOPE" }, [md("AGENTS.md", "# x\n")])))).toEqual(["error metadata.schema metadata.agent_type"]);
    expect(errors(run(asset("agents_md", { agent_type: "GENERIC" }, [md("README.md", "# x\n")])))).toEqual(["error file.main-missing AGENTS.md"]);
    expect(codes(run(asset("agents_md", { agent_type: "GENERIC" }, [md("AGENTS.md", "---\na: b\n---\n# x\n")])))).toEqual([
      "warning frontmatter.present AGENTS.md",
    ]);
  });

  it("warns on memory store agent types that combine GENERIC, without an error", () => {
    const r = run(asset("memory_store", { name: "runbooks", description: "Runbooks.", agent_types: ["GENERIC", "CHAT"] }, [md("README.md", "x")]));
    expect(codes(r)).toEqual(["warning metadata.recommendation metadata.agent_types"]);
  });

  it("errors on memory names outside the service rule, underscores included", () => {
    const mem = (name: string) => asset("memory", { name, description: "d", memory_store_id: "ki-1" }, [md("m.md", "x")]);
    expect(errors(run(mem("Databases/X")))).toEqual(["error metadata.schema metadata.name"]);
    // CreateAsset rejected this name on a test space (2026-11-13).
    expect(errors(run(mem("roles/payment_gw")))).toEqual(["error metadata.schema metadata.name"]);
    expect(run(mem("databases/rds-failover"))).toEqual([]);
  });

  it("protects immutable keys and non-editable types", () => {
    const fb = asset("feedback", { agent_types: ["INCIDENT_TRIAGE"], execution_id: "e2" }, [md("FEEDBACK.md", "{}")], { assetId: "ki-f" });
    expect(errors(run(fb, policy, { metadata: { execution_id: "e1" } }))).toEqual(["error type.not-editable", "error metadata.immutable metadata.execution_id"]);
    expect(errors(run(asset("widget", {}, [md("x.md", "x")])))).toEqual(["error type.unknown"]);
  });

  it("applies extra name patterns from limits.yaml", () => {
    expect(errors(run(skill(), withLimits({ namePatterns: { skill: "^team-" } })))).toEqual(["error name.policy-pattern metadata.name"]);
  });
});

describe("validateDraftAsset: files and limits", () => {
  it("enforces the AGENTS.md size limit and warns above the recommended length", () => {
    const big = run(asset("agents_md", { agent_type: "GENERIC" }, [md("AGENTS.md", "x".repeat(25601))]));
    expect(errors(big)).toEqual(["error file.too-large AGENTS.md"]);
    expect(big[0]!.message).toMatch(/limit is 25 KB \(25600 bytes\)/);
    const exactly = run(asset("agents_md", { agent_type: "GENERIC" }, [md("AGENTS.md", `${Array(120).fill("line").join("\n")}\n`)]));
    expect(exactly).toEqual([]);
    const long = run(asset("agents_md", { agent_type: "GENERIC" }, [md("AGENTS.md", Array(130).fill("line").join("\n"))]));
    expect(codes(long)).toEqual(["warning file.long AGENTS.md"]);
    expect(long[0]!.message).toBe("AGENTS.md has 130 lines; about 120 lines is recommended.");
  });

  it("names a package file by the file it came from, and keeps the asset path in the result", () => {
    const fromPackage = { ...md("AGENTS.md", Array(193).fill("line").join("\n")), sourcePath: "instructions/incident-rca.md" };
    const long = run(asset("agents_md", { agent_type: "INCIDENT_RCA" }, [fromPackage]));
    expect(long.map((r) => [r.code, r.message, r.path])).toEqual([["file.long", "incident-rca.md has 193 lines; about 120 lines is recommended.", "AGENTS.md"]]);
    const big = run(asset("agents_md", { agent_type: "INCIDENT_RCA" }, [{ ...fromPackage, content: "x".repeat(25601) }]));
    expect(big[0]!.message).toMatch(/^incident-rca\.md is 25\.0 KB/);
  });

  it("enforces the memory size limit", () => {
    const r = run(asset("memory", { name: "a/b", description: "d", memory_store_id: "ki-1" }, [md("b.md", "x".repeat(102401))]));
    expect(errors(r)).toEqual(["error file.too-large b.md"]);
  });

  it("enforces the single text file and zip limits", () => {
    expect(errors(run(skill(), withLimits({ singleTextFileMaxBytes: 4 })))).toEqual(["error file.too-large SKILL.md"]);
    const files = [md("SKILL.md", SKILL_FM), md("references/a.md", randomBytes(900).toString("base64"))];
    expect(errors(run(skill({}, files), withLimits({ zipMaxBytes: 300 })))).toEqual(["error zip.too-large"]);
    expect(run(skill({}, files))).toEqual([]);
  });

  it("requires SKILL.md frontmatter that matches metadata for zip uploads", () => {
    const noFm = run(skill({}, [md("SKILL.md", "# RDS\n"), md("references/a.md", "x")]));
    expect(errors(noFm)).toEqual(["error frontmatter.missing SKILL.md"]);
    const other = run(skill({}, [md("SKILL.md", SKILL_FM.replace("name: rds-check", "name: other")), md("references/a.md", "x")]));
    expect(errors(other)).toEqual(["error frontmatter.mismatch SKILL.md"]);
  });

  it("rejects unsafe, duplicate and missing files", () => {
    expect(errors(run(skill({}, [md("SKILL.md", SKILL_FM), md("../x.md", "x")])))).toEqual(["error file.unsafe-path ../x.md"]);
    expect(errors(run(skill({}, [md("SKILL.md", SKILL_FM), md("SKILL.md", SKILL_FM)])))).toContain("error file.duplicate-path SKILL.md");
    expect(errors(run(skill({}, [])))).toEqual(["error content.missing"]);
    expect(errors(run(asset("memory", { name: "a", description: "d", memory_store_id: "m" }, [md("a.md", "x"), md("b.md", "y")])))).toEqual([
      "error content.too-many-files",
    ]);
  });
});
