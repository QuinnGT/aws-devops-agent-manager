import JSZip from "jszip";

/**
 * Zip input safety (AGENTS.md: reject absolute paths, ".." segments and
 * symlinks). The central directory is read directly, before JSZip touches the
 * archive, because JSZip rewrites unsafe names while loading. Sizes and the
 * entry count are capped from policy, and every entry is decompressed with a
 * running byte budget, so a header that understates its size is caught too.
 * Nothing from a zip is ever written to disk under its own name.
 */

export class UnsafeZipError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UnsafeZipError";
  }
}

export interface ZipLimits {
  maxEntries: number;
  maxUncompressedBytes: number;
  maxEntryBytes: number;
}

export interface ZipEntryInfo {
  name: string;
  compressedSize: number;
  uncompressedSize: number;
  isDirectory: boolean;
  isSymlink: boolean;
  encrypted: boolean;
}

const EOCD_SIG = 0x06054b50;
const CDH_SIG = 0x02014b50;
const ZIP64_EOCD_LOCATOR_SIG = 0x07064b50;

function findEocd(buf: Buffer): number {
  const min = Math.max(0, buf.length - (0xffff + 22));
  for (let i = buf.length - 22; i >= min; i--) {
    if (buf.readUInt32LE(i) === EOCD_SIG) return i;
  }
  return -1;
}

/** Read every central directory entry. Throws UnsafeZipError for archives this app does not accept. */
export function readCentralDirectory(buf: Buffer): ZipEntryInfo[] {
  if (buf.length < 22) throw new UnsafeZipError("The file is not a zip archive.");
  const eocd = findEocd(buf);
  if (eocd < 0) throw new UnsafeZipError("The file is not a zip archive.");
  if (eocd >= 20 && buf.readUInt32LE(eocd - 20) === ZIP64_EOCD_LOCATOR_SIG) throw new UnsafeZipError("Zip64 archives are not supported.");
  const disk = buf.readUInt16LE(eocd + 4);
  const total = buf.readUInt16LE(eocd + 10);
  const cdSize = buf.readUInt32LE(eocd + 12);
  const cdOffset = buf.readUInt32LE(eocd + 16);
  if (disk !== 0) throw new UnsafeZipError("Multi-part zip archives are not supported.");
  if (total === 0xffff || cdSize === 0xffffffff || cdOffset === 0xffffffff) throw new UnsafeZipError("Zip64 archives are not supported.");
  if (cdOffset + cdSize > eocd) throw new UnsafeZipError("The zip archive is damaged.");

  const entries: ZipEntryInfo[] = [];
  let p = cdOffset;
  for (let i = 0; i < total; i++) {
    if (p + 46 > buf.length || buf.readUInt32LE(p) !== CDH_SIG) throw new UnsafeZipError("The zip archive is damaged.");
    const madeBy = buf.readUInt16LE(p + 4);
    const flags = buf.readUInt16LE(p + 8);
    const compressedSize = buf.readUInt32LE(p + 20);
    const uncompressedSize = buf.readUInt32LE(p + 24);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const externalAttrs = buf.readUInt32LE(p + 38);
    if (p + 46 + nameLen > buf.length) throw new UnsafeZipError("The zip archive is damaged.");
    const nameBytes = buf.subarray(p + 46, p + 46 + nameLen);
    const name = flags & 0x800 ? nameBytes.toString("utf8") : nameBytes.toString("latin1");
    const unixMode = (externalAttrs >>> 16) & 0xffff;
    const isUnix = madeBy >> 8 === 3;
    if (compressedSize === 0xffffffff || uncompressedSize === 0xffffffff) throw new UnsafeZipError("Zip64 archives are not supported.");
    entries.push({
      name,
      compressedSize,
      uncompressedSize,
      isDirectory: name.endsWith("/") || name.endsWith("\\"),
      isSymlink: isUnix && (unixMode & 0o170000) === 0o120000,
      encrypted: (flags & 0x1) === 1,
    });
    p += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

/** Why an entry name is unsafe, or null when it is fine. */
export function unsafeNameReason(name: string): string | null {
  if (name.length === 0) return "an empty name";
  if (name.includes("\0")) return "a NUL character";
  if (name.startsWith("/") || name.startsWith("\\") || /^[A-Za-z]:/.test(name)) return "an absolute path";
  if (name.split(/[\\/]/).includes("..")) return 'a ".." segment';
  if (name.split(/[\\/]/).slice(0, -1).includes(".")) return 'a "." segment';
  return null;
}

export function assertSafeEntries(entries: ZipEntryInfo[], limits: ZipLimits): void {
  if (entries.length > limits.maxEntries) throw new UnsafeZipError(`The zip has ${entries.length} entries; the limit is ${limits.maxEntries}.`);
  let total = 0;
  const seen = new Set<string>();
  for (const e of entries) {
    const reason = unsafeNameReason(e.name);
    if (reason) throw new UnsafeZipError(`Rejected zip entry "${e.name}": it has ${reason}.`);
    if (e.isSymlink) throw new UnsafeZipError(`Rejected zip entry "${e.name}": symbolic links are not allowed.`);
    if (e.encrypted) throw new UnsafeZipError(`Rejected zip entry "${e.name}": encrypted entries are not supported.`);
    const key = e.name.replace(/\\/g, "/");
    if (seen.has(key)) throw new UnsafeZipError(`Rejected zip: "${e.name}" appears more than once.`);
    seen.add(key);
    if (e.uncompressedSize > limits.maxEntryBytes) throw new UnsafeZipError(`Rejected zip entry "${e.name}": it is larger than ${limits.maxEntryBytes} bytes.`);
    total += e.uncompressedSize;
    if (total > limits.maxUncompressedBytes) throw new UnsafeZipError(`Rejected zip: its files add up to more than ${limits.maxUncompressedBytes} bytes.`);
  }
}

export interface SafeZip {
  entries: ZipEntryInfo[];
  /** Files only (no directories), in archive order */
  files: string[];
  /** Read one file as UTF-8, within the per-entry and total budgets */
  readText(name: string): Promise<string>;
}

export async function openSafeZip(buf: Buffer, limits: ZipLimits): Promise<SafeZip> {
  const entries = readCentralDirectory(buf);
  assertSafeEntries(entries, limits);
  // checkCRC32 would decompress every entry during load, before any size cap applies.
  const zip = await JSZip.loadAsync(buf, { checkCRC32: false });
  const declared = new Map(entries.map((e) => [e.name, e.uncompressedSize]));
  const files = entries.filter((e) => !e.isDirectory).map((e) => e.name);
  for (const f of files) if (!zip.file(f)) throw new UnsafeZipError(`The zip archive is damaged (missing "${f}").`);
  let remaining = limits.maxUncompressedBytes;
  return {
    entries,
    files,
    async readText(name) {
      const file = zip.file(name);
      if (!file || !files.includes(name)) throw new UnsafeZipError(`"${name}" is not in the zip.`);
      // An entry may not decompress to more than its header declares, the per-entry limit, or what is left of the total.
      const bytes = await readCapped(file, Math.min(declared.get(name) ?? 0, limits.maxEntryBytes, remaining), name);
      remaining -= bytes.length;
      return bytes.toString("utf8");
    },
  };
}

function readCapped(file: JSZip.JSZipObject, cap: number, name: string): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    let done = false;
    const stream = file.nodeStream("nodebuffer");
    stream.on("data", (chunk: Buffer) => {
      if (done) return;
      total += chunk.length;
      if (total > cap) {
        done = true;
        stream.pause();
        reject(new UnsafeZipError(`Rejected zip entry "${name}": it decompresses to more than the allowed size.`));
        return;
      }
      chunks.push(chunk);
    });
    stream.on("error", (err: Error) => {
      if (done) return;
      done = true;
      reject(err);
    });
    stream.on("end", () => {
      if (done) return;
      done = true;
      resolve(Buffer.concat(chunks));
    });
  });
}
