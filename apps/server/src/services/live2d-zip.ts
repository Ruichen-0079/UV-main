import { inflateRawSync } from "node:zlib";

export const LIVE2D_ZIP_LIMIT = 64 * 1024 * 1024;
export const LIVE2D_ZIP_ENTRY_LIMIT = 512;

type ZipEntry = {
  path: string;
  compression: number;
  crc32: number;
  compressedSize: number;
  uncompressedSize: number;
  localHeaderOffset: number;
};

const EOCD_SIGNATURE = 0x06054b50;
const CENTRAL_SIGNATURE = 0x02014b50;
const LOCAL_SIGNATURE = 0x04034b50;
const UTF8_FLAG = 0x0800;
const ENCRYPTED_FLAG = 0x0001;

function crc32(data: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of data) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function safeArchivePath(value: string): boolean {
  return (
    Boolean(value) &&
    value.length <= 1024 &&
    !value.includes("\0") &&
    !value.includes("\\") &&
    !value.startsWith("/") &&
    !/^[A-Za-z]:/u.test(value) &&
    value.split("/").every((segment) => segment !== "" && segment !== "." && segment !== "..")
  );
}

function findEndOfCentralDirectory(data: Buffer): number {
  const minimum = 22;
  if (data.length < minimum) throw new Error("Invalid ZIP archive.");
  const lowerBound = Math.max(0, data.length - (0xffff + minimum));
  for (let offset = data.length - minimum; offset >= lowerBound; offset -= 1) {
    if (data.readUInt32LE(offset) === EOCD_SIGNATURE) return offset;
  }
  throw new Error("ZIP central directory is missing.");
}

function readEntries(data: Buffer): ZipEntry[] {
  const eocd = findEndOfCentralDirectory(data);
  const disk = data.readUInt16LE(eocd + 4);
  const centralDisk = data.readUInt16LE(eocd + 6);
  const diskEntries = data.readUInt16LE(eocd + 8);
  const totalEntries = data.readUInt16LE(eocd + 10);
  const centralSize = data.readUInt32LE(eocd + 12);
  const centralOffset = data.readUInt32LE(eocd + 16);
  const commentLength = data.readUInt16LE(eocd + 20);

  if (disk !== 0 || centralDisk !== 0 || diskEntries !== totalEntries)
    throw new Error("Multi-disk ZIP archives are not supported.");
  if (totalEntries > LIVE2D_ZIP_ENTRY_LIMIT)
    throw new Error("ZIP archive contains too many entries.");
  if (
    centralSize === 0xffffffff ||
    centralOffset === 0xffffffff ||
    totalEntries === 0xffff
  )
    throw new Error("ZIP64 archives are not supported.");
  if (eocd + 22 + commentLength !== data.length)
    throw new Error("Invalid ZIP end record.");
  if (centralOffset + centralSize > eocd)
    throw new Error("Invalid ZIP central directory bounds.");

  const entries: ZipEntry[] = [];
  const seen = new Set<string>();
  let totalUncompressed = 0;
  let cursor = centralOffset;
  const centralEnd = centralOffset + centralSize;

  for (let index = 0; index < totalEntries; index += 1) {
    if (cursor + 46 > centralEnd || data.readUInt32LE(cursor) !== CENTRAL_SIGNATURE)
      throw new Error("Invalid ZIP central directory entry.");
    const flags = data.readUInt16LE(cursor + 8);
    const compression = data.readUInt16LE(cursor + 10);
    const crc = data.readUInt32LE(cursor + 16);
    const compressedSize = data.readUInt32LE(cursor + 20);
    const uncompressedSize = data.readUInt32LE(cursor + 24);
    const fileNameLength = data.readUInt16LE(cursor + 28);
    const extraLength = data.readUInt16LE(cursor + 30);
    const entryCommentLength = data.readUInt16LE(cursor + 32);
    const diskStart = data.readUInt16LE(cursor + 34);
    const localHeaderOffset = data.readUInt32LE(cursor + 42);
    const end = cursor + 46 + fileNameLength + extraLength + entryCommentLength;

    if (end > centralEnd) throw new Error("Invalid ZIP entry bounds.");
    if (diskStart !== 0 || compressedSize === 0xffffffff || uncompressedSize === 0xffffffff)
      throw new Error("ZIP64 archives are not supported.");
    if (flags & ENCRYPTED_FLAG) throw new Error("Encrypted ZIP archives are not supported.");
    if (compression !== 0 && compression !== 8)
      throw new Error("ZIP compression method is not supported.");

    const nameBytes = data.subarray(cursor + 46, cursor + 46 + fileNameLength);
    const name = nameBytes.toString("utf8");
    if (!(flags & UTF8_FLAG) && name.includes("\ufffd"))
      throw new Error("ZIP filename encoding is not supported.");

    cursor = end;
    if (name.endsWith("/") || name.startsWith("__MACOSX/") || name.endsWith("/.DS_Store") || name === ".DS_Store")
      continue;
    if (!safeArchivePath(name)) throw new Error("Unsafe ZIP entry path.");
    const key = name.toLocaleLowerCase("en-US");
    if (seen.has(key)) throw new Error("Duplicate ZIP entry path.");
    seen.add(key);

    totalUncompressed += uncompressedSize;
    if (totalUncompressed > LIVE2D_ZIP_LIMIT)
      throw new Error("ZIP archive expands beyond 64 MiB.");

    entries.push({
      path: name,
      compression,
      crc32: crc,
      compressedSize,
      uncompressedSize,
      localHeaderOffset
    });
  }

  if (cursor !== centralEnd) throw new Error("ZIP central directory length mismatch.");
  return entries;
}

function extractEntry(data: Buffer, entry: ZipEntry): Buffer {
  const offset = entry.localHeaderOffset;
  if (offset + 30 > data.length || data.readUInt32LE(offset) !== LOCAL_SIGNATURE)
    throw new Error("Invalid ZIP local entry.");
  const fileNameLength = data.readUInt16LE(offset + 26);
  const extraLength = data.readUInt16LE(offset + 28);
  const payloadStart = offset + 30 + fileNameLength + extraLength;
  const payloadEnd = payloadStart + entry.compressedSize;
  if (payloadStart < 0 || payloadEnd > data.length)
    throw new Error("Invalid ZIP payload bounds.");
  const compressed = data.subarray(payloadStart, payloadEnd);

  let output: Buffer;
  if (entry.compression === 0) {
    output = Buffer.from(compressed);
  } else {
    output = inflateRawSync(compressed, {
      maxOutputLength: Math.max(1, entry.uncompressedSize)
    });
  }
  if (output.length !== entry.uncompressedSize)
    throw new Error("ZIP entry size does not match its central directory.");
  if (crc32(output) !== entry.crc32) throw new Error("ZIP entry checksum failed.");
  return output;
}

/**
 * Extract a bounded, ordinary single-disk ZIP into memory.
 * Central-directory sizes are validated before any DEFLATE payload is expanded.
 */
export function extractLive2DZip(data: Buffer): Map<string, Buffer> {
  if (!data.length || data.length > LIVE2D_ZIP_LIMIT)
    throw new Error("ZIP archive must be 64 MiB or smaller.");
  const entries = readEntries(data);
  if (!entries.length) throw new Error("ZIP archive contains no model files.");
  return new Map(entries.map((entry) => [entry.path, extractEntry(data, entry)]));
}
