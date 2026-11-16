import { describe, expect, it } from "vitest";
import { createPlanRequestFromForm, exportRequestFromSearchParams, importRequestFromForm } from "./forms";

const file = (name: string, body: string) => new File([body], name);

describe("importRequestFromForm", () => {
  it("reads a zip upload", async () => {
    const form = new FormData();
    form.set("file", file("pkg.zip", "PK..."));
    form.set("layout", " instruction-folders ");
    const r = await importRequestFromForm(form);
    expect(r.layout).toBe("instruction-folders");
    expect(r.upload.kind).toBe("zip");
    if (r.upload.kind === "zip") {
      expect(r.upload.fileName).toBe("pkg.zip");
      expect(r.upload.bytes.toString()).toBe("PK...");
    }
  });

  it("reads a folder upload with one path per file", async () => {
    const form = new FormData();
    form.append("files", file("global.md", "# Global\n"));
    form.append("paths", "pkg/instructions/global.md");
    form.append("files", file("README.md", "# Readme\n"));
    form.append("paths", "pkg/README.md");
    const r = await importRequestFromForm(form);
    expect(r.layout).toBeUndefined();
    expect(r.upload).toMatchObject({ kind: "folder" });
    if (r.upload.kind === "folder") expect(r.upload.files.map((f) => [f.path, f.data.toString()])).toEqual([["pkg/instructions/global.md", "# Global\n"], ["pkg/README.md", "# Readme\n"]]);
  });

  it("refuses an empty form and missing paths", async () => {
    await expect(importRequestFromForm(new FormData())).rejects.toMatchObject({ code: "bad-request" });
    const form = new FormData();
    form.append("files", file("a.md", "a"));
    await expect(importRequestFromForm(form)).rejects.toMatchObject({ code: "bad-request" });
  });
});

describe("createPlanRequestFromForm and exportRequestFromSearchParams", () => {
  it("parses the plan form", () => {
    const form = new FormData();
    form.set("importId", "0b6f0a62-8c5e-4b9e-9f3e-2f1f5d1f2a10");
    form.set("reason", "  v2 audit ");
    expect(createPlanRequestFromForm(form)).toEqual({ importId: "0b6f0a62-8c5e-4b9e-9f3e-2f1f5d1f2a10", options: { title: null, reason: "v2 audit" } });
    form.set("title", " Import v2.3 ");
    expect(createPlanRequestFromForm(form).options.title).toBe("Import v2.3");
    form.set("title", "t".repeat(201));
    expect(() => createPlanRequestFromForm(form)).toThrow(/not valid/);
    form.delete("title");
    form.set("importId", "../x");
    expect(() => createPlanRequestFromForm(form)).toThrow(/not valid/);
  });

  it("parses the download query", () => {
    expect(exportRequestFromSearchParams(new URLSearchParams("ref=test-space%2Fv1&layout=instruction-folders"))).toEqual({ ref: "test-space/v1", layout: "instruction-folders", name: null });
    expect(exportRequestFromSearchParams(new URLSearchParams("name=+demo-v1+"))).toEqual({ ref: null, layout: null, name: "demo-v1" });
    expect(exportRequestFromSearchParams(new URLSearchParams(""))).toEqual({ ref: null, layout: null, name: null });
    expect(() => exportRequestFromSearchParams(new URLSearchParams(`ref=${"a".repeat(300)}`))).toThrow(/not valid/);
  });
});
