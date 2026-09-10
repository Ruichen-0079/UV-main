import fs from "node:fs";

function requireRange(buffer, offset, bytes, label) {
  if (!Number.isInteger(offset) || offset < 0 || offset + bytes > buffer.length) {
    throw new Error(`Invalid OpenType ${label} bounds.`);
  }
}

function readUInt16(buffer, offset, label) {
  requireRange(buffer, offset, 2, label);
  return buffer.readUInt16BE(offset);
}

function readInt16(buffer, offset, label) {
  requireRange(buffer, offset, 2, label);
  return buffer.readInt16BE(offset);
}

function readUInt32(buffer, offset, label) {
  requireRange(buffer, offset, 4, label);
  return buffer.readUInt32BE(offset);
}

function cmapTable(buffer) {
  requireRange(buffer, 0, 12, "header");
  const numTables = readUInt16(buffer, 4, "table count");
  for (let i = 0; i < numTables; i += 1) {
    const record = 12 + i * 16;
    requireRange(buffer, record, 16, "table record");
    if (buffer.toString("ascii", record, record + 4) !== "cmap") continue;
    const offset = readUInt32(buffer, record + 8, "cmap offset");
    const length = readUInt32(buffer, record + 12, "cmap length");
    requireRange(buffer, offset, length, "cmap table");
    return { offset, length };
  }
  throw new Error("OpenType font has no cmap table.");
}

function unicodeSubtables(buffer) {
  const cmap = cmapTable(buffer);
  const count = readUInt16(buffer, cmap.offset + 2, "cmap subtable count");
  const candidates = [];
  for (let i = 0; i < count; i += 1) {
    const record = cmap.offset + 4 + i * 8;
    requireRange(buffer, record, 8, "cmap encoding record");
    const platformId = readUInt16(buffer, record, "cmap platform id");
    const encodingId = readUInt16(buffer, record + 2, "cmap encoding id");
    const relative = readUInt32(buffer, record + 4, "cmap subtable offset");
    const offset = cmap.offset + relative;
    requireRange(buffer, offset, 2, "cmap subtable");
    const format = readUInt16(buffer, offset, "cmap format");
    if (format !== 4 && format !== 12) continue;
    const unicode = platformId === 0 || (platformId === 3 && (encodingId === 1 || encodingId === 10));
    if (!unicode) continue;
    const priority =
      platformId === 3 && encodingId === 10
        ? 4
        : format === 12
          ? 3
          : platformId === 0
            ? 2
            : 1;
    candidates.push({ offset, format, priority });
  }
  candidates.sort((a, b) => b.priority - a.priority);
  if (candidates.length === 0) throw new Error("OpenType font has no supported Unicode cmap.");
  return candidates;
}

function format12HasGlyph(buffer, offset, codePoint) {
  requireRange(buffer, offset, 16, "format 12 header");
  const length = readUInt32(buffer, offset + 4, "format 12 length");
  requireRange(buffer, offset, length, "format 12 table");
  const groups = readUInt32(buffer, offset + 12, "format 12 group count");
  let low = 0;
  let high = groups - 1;
  while (low <= high) {
    const mid = Math.floor((low + high) / 2);
    const group = offset + 16 + mid * 12;
    requireRange(buffer, group, 12, "format 12 group");
    const start = readUInt32(buffer, group, "format 12 start char");
    const end = readUInt32(buffer, group + 4, "format 12 end char");
    if (codePoint < start) high = mid - 1;
    else if (codePoint > end) low = mid + 1;
    else {
      const startGlyph = readUInt32(buffer, group + 8, "format 12 start glyph");
      return startGlyph + (codePoint - start) !== 0;
    }
  }
  return false;
}

function format4HasGlyph(buffer, offset, codePoint) {
  if (codePoint > 0xffff) return false;
  requireRange(buffer, offset, 16, "format 4 header");
  const length = readUInt16(buffer, offset + 2, "format 4 length");
  requireRange(buffer, offset, length, "format 4 table");
  const segCount = readUInt16(buffer, offset + 6, "format 4 segment count") / 2;
  if (!Number.isInteger(segCount) || segCount <= 0) throw new Error("Invalid format 4 segment count.");
  const endCodes = offset + 14;
  const startCodes = endCodes + segCount * 2 + 2;
  const deltas = startCodes + segCount * 2;
  const rangeOffsets = deltas + segCount * 2;
  for (let i = 0; i < segCount; i += 1) {
    const end = readUInt16(buffer, endCodes + i * 2, "format 4 end code");
    if (codePoint > end) continue;
    const start = readUInt16(buffer, startCodes + i * 2, "format 4 start code");
    if (codePoint < start) return false;
    const delta = readInt16(buffer, deltas + i * 2, "format 4 delta");
    const rangeOffsetPosition = rangeOffsets + i * 2;
    const rangeOffset = readUInt16(buffer, rangeOffsetPosition, "format 4 range offset");
    if (rangeOffset === 0) return ((codePoint + delta) & 0xffff) !== 0;
    const glyphPosition = rangeOffsetPosition + rangeOffset + (codePoint - start) * 2;
    if (glyphPosition + 2 > offset + length) return false;
    let glyph = readUInt16(buffer, glyphPosition, "format 4 glyph id");
    if (glyph === 0) return false;
    glyph = (glyph + delta) & 0xffff;
    return glyph !== 0;
  }
  return false;
}

export function fontHasGlyph(buffer, codePoint) {
  if (!Number.isInteger(codePoint) || codePoint < 0 || codePoint > 0x10ffff) return false;
  for (const subtable of unicodeSubtables(buffer)) {
    if (
      (subtable.format === 12 && format12HasGlyph(buffer, subtable.offset, codePoint)) ||
      (subtable.format === 4 && format4HasGlyph(buffer, subtable.offset, codePoint))
    ) {
      return true;
    }
  }
  return false;
}

export function missingFontGlyphs(buffer, text) {
  const missing = [];
  for (const character of new Set(Array.from(text))) {
    const codePoint = character.codePointAt(0);
    if (codePoint === undefined || !fontHasGlyph(buffer, codePoint)) missing.push(character);
  }
  return missing;
}

export function assertFontCoverage(file, text, label = file) {
  const buffer = fs.readFileSync(file);
  const missing = missingFontGlyphs(buffer, text);
  if (missing.length > 0) {
    const display = missing.map((character) => `${character}(U+${character.codePointAt(0).toString(16).toUpperCase()})`);
    throw new Error(`${label} is missing required glyphs: ${display.join(", ")}`);
  }
}
