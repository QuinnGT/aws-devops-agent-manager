import { crc32, deflateRawSync, inflateRawSync } from "node:zlib";
import { error, type ValidationResult } from "@/server/validation/types";
import { describePathProblem, pathProblem } from "./paths";

/**
 * Zip reading and writing without third-party code.
 *
 * Reading is defensive: the central directory is parsed before anything is
 * decompressed, so entry count and declared sizes are checked first; each
 * entry is inflated with an output cap equal to its declared size, and its
 * CRC is checked. Rejected: absolute paths, ".." segments, backslashes,
 * symlinks and other special files, encryption, ZIP64, multi-disk archives,
 * duplicate names, and local headers whose name differs from the central
 * directory.
 *
 * Writing is deterministic: entries in the order given, a fixed timestamp
 * (1980-01-01 00:00), fixed permissions (0644) and fixed compression settings.
 */

export interface ZipReadLimits {
  maxZipBytes: number;
  maxEntries: number;
  maxEntryBytes: number;
  maxTotalBytes: number;
  maxPathLength: number;
}

export interface ZipEntry {
  /** Entry name as stored (forward slashes); directories end with "/" */
  name: string;
  isDirectory: boolean;
  data: Buffer;
}

export interface ZipReadResult {
  entries: ZipEntry[];
  /** Problems found; when any is an error the archive must be rejected */
  problems: ValidationResult[];
}

const SIG_EOCD = 0x06054b50;
const SIG_CENTRAL = 0x02014b50;
const SIG_LOCAL = 0x04034b50;
const MADE_BY_UNIX = 3;
const MADE_BY_OSX = 19;
const S_IFMT = 0o170000;
const S_IFREG = 0o100000;
const S_IFDIR = 0o040000;
const S_IFLNK = 0o120000;

// Code page 437, bytes 0x80-0xFF (names without the UTF-8 flag, as Python's zipfile reads them).
const CP437_HIGH =
  "ÇüéâäàåçêëèïîìÄÅÉæÆôöòûùÿÖÜ¢£¥₧ƒáíóúñÑªº¿⌐¬½¼¡«»░▒▓│┤╡╢╖╕╣║╗╝╜╛┐└┴┬├─┼╞╟╚╔╩╦╠═╬╧╨╤╥╙╘╒╓╫╪┘┌█▄▌▐▀αßΓπΣσµτΦΘΩδ∞φε∩≡±≥≤⌠⌡÷≈°∙·√ⁿ²■\u00a0";

function decodeName(bytes: Buffer, utf8Flag: boolean): string {
  if (utf8Flag) return bytes.toString("utf8");
  let out = "";
  for (const b of bytes) out += b < 0x80 ? String.fromCharCode(b) : CP437_HIGH[b - 0x80];
  return out;
}

/** Read every entry of a zip archive, enforcing the limits. Never throws for bad input. */
export function readZip(buf: Buffer, limits: ZipReadLimits, label = "zip"): ZipReadResult {
  const problems: ValidationResult[] = [];
  const reject = (message: string, path?: string): ZipReadResult => {
    problems.push(error("zip.rejected", `${label}: ${message}`, path ? { path } : {}));
    return { entries: [], problems };
  };

  if (buf.length > limits.maxZipBytes) return reject(`the archive is ${buf.length} bytes; the limit is ${limits.maxZipBytes}`);
  if (buf.length < 22) return reject("not a zip archive");

  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 22 - 0xffff); i--) {
    if (buf.readUInt32LE(i) === SIG_EOCD) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) return reject("not a zip archive (no end of central directory)");
  const disk = buf.readUInt16LE(eocd + 4);
  const cdDisk = buf.readUInt16LE(eocd + 6);
  const total = buf.readUInt16LE(eocd + 10);
  const cdSize = buf.readUInt32LE(eocd + 12);
  const cdOffset = buf.readUInt32LE(eocd + 16);
  if (disk !== 0 || cdDisk !== 0) return reject("multi-disk archives are not supported");
  if (total === 0xffff || cdOffset === 0xffffffff || cdSize === 0xffffffff) return reject("ZIP64 archives are not supported");
  if (total > limits.maxEntries) return reject(`the archive has ${total} entries; the limit is ${limits.maxEntries}`);
  if (cdOffset + cdSize > eocd) return reject("the central directory is out of bounds");

  const entries: ZipEntry[] = [];
  const names = new Set<string>();
  let declaredTotal = 0;
  let p = cdOffset;
  for (let n = 0; n < total; n++) {
    if (p + 46 > eocd || buf.readUInt32LE(p) !== SIG_CENTRAL) return reject("the central directory is corrupt");
    const madeBy = buf.readUInt16LE(p + 4) >> 8;
    const flags = buf.readUInt16LE(p + 8);
    const method = buf.readUInt16LE(p + 10);
    const crc = buf.readUInt32LE(p + 16);
    const compSize = buf.readUInt32LE(p + 20);
    const size = buf.readUInt32LE(p + 24);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const external = buf.readUInt32LE(p + 38);
    const localOffset = buf.readUInt32LE(p + 42);
    const nameBytes = buf.subarray(p + 46, p + 46 + nameLen);
    p += 46 + nameLen + extraLen + commentLen;
    if (p > eocd) return reject("the central directory is corrupt");

    const name = decodeName(nameBytes, (flags & 0x800) !== 0);
    const problem = pathProblem(name, limits.maxPathLength);
    if (problem) return reject(`entry ${JSON.stringify(name)} ${describePathProblem(problem)}`, name);
    if (names.has(name)) return reject(`entry ${name} appears more than once`, name);
    names.add(name);
    if (flags & 0x41) return reject(`entry ${name} is encrypted`, name);
    if (compSize === 0xffffffff || size === 0xffffffff) return reject("ZIP64 archives are not supported", name);

    let isDirectory = name.endsWith("/") || (external & 0x10) !== 0;
    if (madeBy === MADE_BY_UNIX || madeBy === MADE_BY_OSX) {
      const type = (external >>> 16) & S_IFMT;
      if (type === S_IFLNK) return reject(`entry ${name} is a symbolic link`, name);
      if (type !== 0 && type !== S_IFREG && type !== S_IFDIR) return reject(`entry ${name} is not a regular file`, name);
      if (type === S_IFDIR) isDirectory = true;
    }
    if (isDirectory) {
      if (!name.endsWith("/")) return reject(`directory entry ${name} has no trailing slash`, name);
      if (size !== 0) return reject(`directory entry ${name} has content`, name);
      entries.push({ name, isDirectory: true, data: Buffer.alloc(0) });
      continue;
    }
    if (method !== 0 && method !== 8) return reject(`entry ${name} uses unsupported compression method ${method}`, name);
    if (size > limits.maxEntryBytes) return reject(`entry ${name} is ${size} bytes; the limit is ${limits.maxEntryBytes}`, name);
    declaredTotal += size;
    if (declaredTotal > limits.maxTotalBytes) return reject(`the files total more than ${limits.maxTotalBytes} bytes`, name);

    if (localOffset + 30 > buf.length || buf.readUInt32LE(localOffset) !== SIG_LOCAL) return reject(`entry ${name} has no local header`, name);
    const localNameLen = buf.readUInt16LE(localOffset + 26);
    const localExtraLen = buf.readUInt16LE(localOffset + 28);
    const localName = buf.subarray(localOffset + 30, localOffset + 30 + localNameLen);
    if (!localName.equals(nameBytes)) return reject(`entry ${name} has a different name in its local header`, name);
    const start = localOffset + 30 + localNameLen + localExtraLen;
    if (start + compSize > buf.length) return reject(`entry ${name} is truncated`, name);
    const compressed = buf.subarray(start, start + compSize);

    let data: Buffer;
    if (method === 0) {
      if (compSize !== size) return reject(`entry ${name} has inconsistent sizes`, name);
      data = Buffer.from(compressed);
    } else {
      try {
        data = size === 0 ? Buffer.alloc(0) : inflateRawSync(compressed, { maxOutputLength: size });
      } catch {
        return reject(`entry ${name} is corrupt or larger than its header says`, name);
      }
      if (data.length !== size) return reject(`entry ${name} is corrupt (size mismatch)`, name);
    }
    if (crc32(data) >>> 0 !== crc) return reject(`entry ${name} is corrupt (CRC mismatch)`, name);
    entries.push({ name, isDirectory: false, data });
  }
  return { entries, problems };
}

export interface ZipWriteEntry {
  name: string;
  data: Buffer;
}

const DOS_TIME = 0;
const DOS_DATE = (0 << 9) | (1 << 5) | 1; // 1980-01-01
const UNIX_FILE_MODE = 0o100644;

/** Write a zip deterministically: same entries in, same bytes out. */
export function writeZip(entries: readonly ZipWriteEntry[]): Buffer {
  if (entries.length > 0xfffe) throw new Error("too many zip entries");
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  const seen = new Set<string>();
  let offset = 0;
  for (const { name, data } of entries) {
    const problem = pathProblem(name);
    if (problem) throw new Error(`zip entry ${JSON.stringify(name)} ${describePathProblem(problem)}`);
    if (seen.has(name)) throw new Error(`duplicate zip entry ${name}`);
    seen.add(name);
    const nameBytes = Buffer.from(name, "utf8");
    const flags = /^[\x20-\x7e]*$/.test(name) ? 0 : 0x800;
    const crc = crc32(data) >>> 0;
    let method = 0;
    let body = data;
    if (data.length > 0) {
      const deflated = deflateRawSync(data, { level: 6, memLevel: 8, windowBits: 15 });
      if (deflated.length < data.length) {
        method = 8;
        body = deflated;
      }
    }
    if (offset > 0xffffffff || body.length > 0xffffffff) throw new Error("zip too large");

    const local = Buffer.alloc(30);
    local.writeUInt32LE(SIG_LOCAL, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(flags, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(DOS_TIME, 10);
    local.writeUInt16LE(DOS_DATE, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    local.writeUInt16LE(0, 28);
    locals.push(local, nameBytes, body);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(SIG_CENTRAL, 0);
    central.writeUInt16LE((MADE_BY_UNIX << 8) | 20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(flags, 8);
    central.writeUInt16LE(method, 10);
    central.writeUInt16LE(DOS_TIME, 12);
    central.writeUInt16LE(DOS_DATE, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(body.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(nameBytes.length, 28);
    central.writeUInt32LE((UNIX_FILE_MODE << 16) >>> 0, 38);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, nameBytes);

    offset += 30 + nameBytes.length + body.length;
  }
  const cd = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(SIG_EOCD, 0);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(cd.length, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, eocd]);
}

/** Entry names of a zip (directories included), or null when it can't be read. */
export function zipEntryNames(buf: Buffer, limits: ZipReadLimits): string[] | null {
  const { entries, problems } = readZip(buf, limits);
  return problems.some((p) => p.level === "error") ? null : entries.map((e) => e.name);
}
