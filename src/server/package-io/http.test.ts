import { describe, expect, it } from "vitest";
import { getAppPolicy } from "@/server/policy";
import { lineDiffStat } from "./analyze";
import { bodyProblem, formatBytes, isCrossSiteRequest, parseMultipart, readBodyWithLimit, refusalText, UploadBodyError, uploadBodyLimit } from "./http";
import { PackageIoError } from "./types";

const limits = getAppPolicy().policy.limits.packageRead;

function streamRequest(chunks: Uint8Array[], headers: Record<string, string> = {}) {
  const body = new ReadableStream<Uint8Array>({
    start(c) {
      for (const ch of chunks) c.enqueue(ch);
      c.close();
    },
  });
  return new Request("http://127.0.0.1/x", { method: "POST", body, headers, duplex: "half" } as RequestInit);
}

describe("upload body limit", () => {
  it("covers a folder at maxTotalBytes plus the multipart framing of maxEntries files", () => {
    const limit = uploadBodyLimit(limits);
    expect(limit).toBeGreaterThan(limits.maxTotalBytes + limits.maxEntries * 2 * limits.maxPathLength);
    expect(limit).toBeLessThan(limits.maxTotalBytes * 1.1);
  });

  it("reads a body up to the limit", async () => {
    const buf = await readBodyWithLimit(streamRequest([new Uint8Array([1, 2]), new Uint8Array([3])]), 3);
    expect([...buf]).toEqual([1, 2, 3]);
  });

  it("refuses a declared length over the limit before reading", async () => {
    const err = await readBodyWithLimit(streamRequest([new Uint8Array(1)], { "content-length": "100" }), 10).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(UploadBodyError);
    expect(err).toMatchObject({ kind: "too-large", received: 100, declared: 100 });
  });

  it("stops reading a body that grows past the limit", async () => {
    const err = await readBodyWithLimit(streamRequest([new Uint8Array(6), new Uint8Array(6)]), 10).catch((e: unknown) => e);
    expect(err).toMatchObject({ kind: "too-large", received: 12, declared: null });
  });

  it("refuses a body shorter than its Content-Length instead of reading part of a package", async () => {
    const err = await readBodyWithLimit(streamRequest([new Uint8Array(4)], { "content-length": "9" }), 100).catch((e: unknown) => e);
    expect(err).toMatchObject({ kind: "truncated", received: 4, declared: 9 });
    expect(bodyProblem(err as UploadBodyError, limits)).toMatchObject({ title: "The upload was cut off", body: "The app received 4 bytes of 9 bytes. Upload the package again." });
  });

  it("parses multipart bodies and refuses other content types", async () => {
    const form = new FormData();
    form.set("layout", "instruction-folders");
    form.set("file", new File(["PK"], "a.zip"));
    const req = new Request("http://127.0.0.1/x", { method: "POST", body: form });
    const parsed = await parseMultipart(Buffer.from(await req.arrayBuffer()), req.headers.get("content-type"));
    expect(parsed.get("layout")).toBe("instruction-folders");
    expect((parsed.get("file") as File).name).toBe("a.zip");
    await expect(parseMultipart(Buffer.from("{}"), "application/json")).rejects.toBeInstanceOf(PackageIoError);
    await expect(parseMultipart(Buffer.from("garbage"), "multipart/form-data; boundary=zzz")).rejects.toMatchObject({ code: "bad-request" });
  });
});

describe("helpers", () => {
  it("formats sizes in binary units", () => {
    expect(formatBytes(33554432)).toBe("32 MB");
    expect(formatBytes(1.5 * 1024 * 1024)).toBe("1.5 MB");
    expect(formatBytes(144_384)).toBe("141 KB");
    expect(formatBytes(12)).toBe("12 bytes");
  });

  it("detects cross-site browser requests", () => {
    const req = (h: Record<string, string>) => new Request("http://127.0.0.1:3203/x", { method: "POST", headers: { host: "127.0.0.1:3203", ...h } });
    expect(isCrossSiteRequest(req({}), [])).toBe(false);
    expect(isCrossSiteRequest(req({ origin: "http://127.0.0.1:3203" }), [])).toBe(false);
    expect(isCrossSiteRequest(req({ origin: "https://evil.example" }), [])).toBe(true);
    expect(isCrossSiteRequest(req({ origin: "https://dam.example.com" }), ["dam.example.com"])).toBe(false);
    expect(isCrossSiteRequest(req({ origin: "https://dam.example.com" }), ["https://dam.example.com"])).toBe(false);
    expect(isCrossSiteRequest(req({ "sec-fetch-site": "cross-site" }), [])).toBe(true);
    expect(isCrossSiteRequest(req({ origin: "null" }), [])).toBe(true);
  });

  it("writes a refused download as plain lines", () => {
    const results = Array.from({ length: 22 }, (_, i) => ({ level: "error" as const, code: "x", message: `m${i}` }));
    const text = refusalText(new PackageIoError("checks-failed", "The package doesn't pass its checks: 22 errors.", results));
    expect(text.split("\n")).toHaveLength(22);
    expect(text.split("\n").at(-1)).toBe("and 2 more");
    expect(text.split("\n")[1]).toBe("m0"); // the sentence only, no "(x)" code
  });

  it("counts lines added and removed", () => {
    expect(lineDiffStat("a\nb\nc\n", "a\nB\nc\nd\n")).toEqual({ added: 2, removed: 1 });
    expect(lineDiffStat("", "x\n")).toEqual({ added: 1, removed: 0 });
  });
});
