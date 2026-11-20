import { describe, expect, it } from "vitest";
import { pushPlanOf, recordFiles, recordFilesFromCommit, savedRecordFrom } from "./record";

const DIR = "audits/anycompany-tickets/c10c4423";

describe("where the record goes", () => {
  it("pushes when the repository has a remote and push is on", () => {
    expect(pushPlanOf({ remoteUrl: "git@github.com:acme/history.git", pushEnabled: true })).toEqual({ kind: "pushes", remote: "git@github.com:acme/history.git" });
  });

  it("stays local without a remote, or with push off", () => {
    expect(pushPlanOf({ remoteUrl: null, pushEnabled: false })).toEqual({ kind: "local", reason: "no-remote", remote: null });
    expect(pushPlanOf({ remoteUrl: null, pushEnabled: true })).toMatchObject({ reason: "no-remote" });
    expect(pushPlanOf({ remoteUrl: "https://example.com/h.git", pushEnabled: false })).toEqual({ kind: "local", reason: "push-off", remote: "https://example.com/h.git" });
  });
});

describe("which files are new", () => {
  it("lists the three files, new when the folder doesn't hold them", () => {
    expect(recordFiles(DIR, [])).toEqual([
      { name: "audit.json", status: "new" },
      { name: "findings.json", status: "new" },
      { name: "report.md", status: "new" },
    ]);
  });

  it("marks a file that is already in the folder as changed", () => {
    const files = recordFiles(DIR, [`${DIR}/report.md`, "audits/anycompany-tickets/other/audit.json"]);
    expect(files.map((f) => [f.name, f.status])).toEqual([
      ["audit.json", "new"],
      ["findings.json", "new"],
      ["report.md", "changed"],
    ]);
  });

  it("reads a commit's added and modified paths", () => {
    const files = recordFilesFromCommit(DIR, [
      { status: "added", path: `${DIR}/audit.json` },
      { status: "modified", path: `${DIR}/findings.json` },
    ]);
    expect(files.map((f) => f.status)).toEqual(["new", "changed", "new"]);
    expect(recordFilesFromCommit(DIR, []).every((f) => f.status === "new")).toBe(true);
  });
});

describe("what a save did", () => {
  const audit = { finalizedCommit: "5e1c2a90cafe00005e1c2a90cafe00005e1c2a90", finalizedBy: "alex@example.com", finalizedAt: new Date("2026-11-18T23:41:00Z") };
  const fallback = { branch: "main", folder: `${DIR}/` };

  it("is nothing before the record is saved", () => {
    expect(savedRecordFrom({ ...audit, finalizedCommit: null }, null, fallback)).toBeNull();
  });

  it("reads the push result, branch, remote and files from the worker's event", () => {
    const s = savedRecordFrom(audit, { details: { commit: audit.finalizedCommit, dir: DIR, branch: "release", remote: "git@github.com:acme/history.git", pushed: true, files: [{ name: "audit.json", status: "new" }, { name: "report.md", status: "changed" }] } }, fallback);
    expect(s).toMatchObject({ commit: audit.finalizedCommit, by: "alex@example.com", branch: "release", folder: `${DIR}/`, push: { pushed: true, error: null, remote: "git@github.com:acme/history.git" } });
    expect(s!.files.map((f) => [f.name, f.status])).toEqual([
      ["audit.json", "new"],
      ["findings.json", "new"],
      ["report.md", "changed"],
    ]);
  });

  it("keeps a push error", () => {
    const s = savedRecordFrom(audit, { details: { dir: DIR, pushed: false, pushError: "remote rejected", remote: "git@example.com:h.git" } }, fallback);
    expect(s!.push).toEqual({ pushed: false, error: "remote rejected", remote: "git@example.com:h.git" });
  });

  it("says the push result was not kept for a save made before the event kept it", () => {
    expect(savedRecordFrom(audit, null, fallback)).toMatchObject({ push: null, branch: "main", folder: `${DIR}/` });
    expect(savedRecordFrom(audit, { details: { commit: audit.finalizedCommit } }, fallback)!.push).toBeNull();
  });
});
