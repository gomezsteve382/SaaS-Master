#!/usr/bin/env node
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";

const DEFAULT_INPUT = "C:\\Users\\gomez\\Desktop\\CDA.swf";
const DEFAULT_OUTPUT =
  "C:\\Users\\gomez\\Documents\\Codex\\2026-05-20\\files-mentioned-by-the-user-srt\\cda_extracted";

const TAG_NAMES = {
  0: "End",
  1: "ShowFrame",
  2: "DefineShape",
  4: "PlaceObject",
  5: "RemoveObject",
  6: "DefineBits",
  7: "DefineButton",
  8: "JPEGTables",
  9: "SetBackgroundColor",
  10: "DefineFont",
  11: "DefineText",
  12: "DoAction",
  13: "DefineFontInfo",
  14: "DefineSound",
  15: "StartSound",
  17: "DefineButtonSound",
  18: "SoundStreamHead",
  19: "SoundStreamBlock",
  20: "DefineBitsLossless",
  21: "DefineBitsJPEG2",
  22: "DefineShape2",
  23: "DefineButtonCxform",
  24: "Protect",
  26: "PlaceObject2",
  28: "RemoveObject2",
  32: "DefineShape3",
  33: "DefineText2",
  34: "DefineButton2",
  35: "DefineBitsJPEG3",
  36: "DefineBitsLossless2",
  37: "DefineEditText",
  39: "DefineSprite",
  41: "ProductInfo",
  43: "FrameLabel",
  45: "SoundStreamHead2",
  46: "DefineMorphShape",
  48: "DefineFont2",
  56: "ExportAssets",
  57: "ImportAssets",
  58: "EnableDebugger",
  59: "DoInitAction",
  60: "DefineVideoStream",
  61: "VideoFrame",
  62: "DefineFontInfo2",
  64: "EnableDebugger2",
  65: "ScriptLimits",
  66: "SetTabIndex",
  69: "FileAttributes",
  70: "PlaceObject3",
  71: "ImportAssets2",
  72: "DoABCDefine",
  73: "DefineFontAlignZones",
  74: "CSMTextSettings",
  75: "DefineFont3",
  76: "SymbolClass",
  77: "Metadata",
  78: "DefineScalingGrid",
  82: "DoABC",
  83: "DefineShape4",
  84: "DefineMorphShape2",
  86: "DefineSceneAndFrameLabelData",
  87: "DefineBinaryData",
  88: "DefineFontName",
  89: "StartSound2",
  90: "DefineBitsJPEG4",
  91: "DefineFont4",
};

const CHARACTER_ID_TAGS = new Set([
  2, 6, 7, 10, 11, 14, 20, 21, 22, 32, 33, 34, 35, 36, 37, 39, 46, 48, 60, 61,
  62, 73, 75, 83, 84, 87, 88, 90, 91,
]);

function parseArgs(argv) {
  const parsed = {
    input: DEFAULT_INPUT,
    out: DEFAULT_OUTPUT,
  };

  for (let i = 2; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--input" && argv[i + 1]) {
      parsed.input = argv[i + 1];
      i += 1;
    } else if (arg === "--out" && argv[i + 1]) {
      parsed.out = argv[i + 1];
      i += 1;
    } else if (arg === "--help" || arg === "-h") {
      parsed.help = true;
    }
  }

  return parsed;
}

function usage() {
  return [
    "Usage:",
    "  node extract-cda-swf.mjs [--input <path-to-swf>] [--out <output-dir>]",
    "",
    `Defaults:`,
    `  --input ${DEFAULT_INPUT}`,
    `  --out   ${DEFAULT_OUTPUT}`,
  ].join("\n");
}

function toPosix(p) {
  return p.split(path.sep).join("/");
}

function ensureDir(p) {
  fs.mkdirSync(p, { recursive: true });
}

function sha256(buffer) {
  return crypto.createHash("sha256").update(buffer).digest("hex");
}

function sanitizeSegment(input) {
  return String(input || "")
    .trim()
    .replace(/[^\w.-]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 80) || "unnamed";
}

function pad(num, width) {
  return String(num).padStart(width, "0");
}

function tagName(code) {
  return TAG_NAMES[code] || `Tag${code}`;
}

function detectBinaryExtension(buf) {
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) {
    return "jpg";
  }
  if (
    buf.length >= 4 &&
    buf[0] === 0x89 &&
    buf[1] === 0x50 &&
    buf[2] === 0x4e &&
    buf[3] === 0x47
  ) {
    return "png";
  }
  if (
    buf.length >= 4 &&
    buf[0] === 0x47 &&
    buf[1] === 0x49 &&
    buf[2] === 0x46 &&
    buf[3] === 0x38
  ) {
    return "gif";
  }
  if (
    buf.length >= 3 &&
    ((buf[0] === 0x46 && buf[1] === 0x57 && buf[2] === 0x53) ||
      (buf[0] === 0x43 && buf[1] === 0x57 && buf[2] === 0x53) ||
      (buf[0] === 0x5a && buf[1] === 0x57 && buf[2] === 0x53))
  ) {
    return "swf";
  }
  if (
    buf.length >= 4 &&
    buf[0] === 0x50 &&
    buf[1] === 0x4b &&
    buf[2] === 0x03 &&
    buf[3] === 0x04
  ) {
    return "zip";
  }
  return "bin";
}

function readNullTerminatedString(buf, offset) {
  let cursor = offset;
  while (cursor < buf.length && buf[cursor] !== 0x00) {
    cursor += 1;
  }
  const value = buf.subarray(offset, cursor).toString("utf8");
  const next = cursor < buf.length ? cursor + 1 : cursor;
  return { value, next };
}

function rectByteLength(buf, offset) {
  const nbits = buf[offset] >> 3;
  const totalBits = 5 + nbits * 4;
  return Math.ceil(totalBits / 8);
}

function parseDoABC(payload) {
  if (payload.length < 4) {
    throw new Error("DoABC payload too small for flags");
  }
  const flags = payload.readUInt32LE(0);
  const { value: name, next } = readNullTerminatedString(payload, 4);
  if (next > payload.length) {
    throw new Error("DoABC name parse overflow");
  }
  const abcData = payload.subarray(next);
  return {
    flags,
    lazyInitialize: (flags & 0x1) === 0x1,
    name,
    abcDataOffset: next,
    abcDataLength: abcData.length,
    abcData,
  };
}

function parseDefineBinaryData(payload) {
  if (payload.length < 6) {
    throw new Error("DefineBinaryData payload too small");
  }
  const characterId = payload.readUInt16LE(0);
  const reserved = payload.readUInt32LE(2);
  const data = payload.subarray(6);
  return {
    characterId,
    reserved,
    dataLength: data.length,
    data,
  };
}

function parseSymbolClass(payload) {
  if (payload.length < 2) {
    throw new Error("SymbolClass payload too small");
  }
  const count = payload.readUInt16LE(0);
  const symbols = [];
  let cursor = 2;
  for (let i = 0; i < count; i += 1) {
    if (cursor + 2 > payload.length) {
      throw new Error(`SymbolClass truncated at symbol ${i}`);
    }
    const characterId = payload.readUInt16LE(cursor);
    cursor += 2;
    const parsed = readNullTerminatedString(payload, cursor);
    cursor = parsed.next;
    symbols.push({
      index: i,
      characterId,
      className: parsed.value,
    });
  }
  return {
    count,
    symbols,
    bytesConsumed: cursor,
    trailingBytes: payload.length - cursor,
  };
}

function parseExportAssets(payload) {
  if (payload.length < 2) {
    throw new Error("ExportAssets payload too small");
  }
  const count = payload.readUInt16LE(0);
  const exports = [];
  let cursor = 2;
  for (let i = 0; i < count; i += 1) {
    if (cursor + 2 > payload.length) {
      throw new Error(`ExportAssets truncated at export ${i}`);
    }
    const characterId = payload.readUInt16LE(cursor);
    cursor += 2;
    const parsed = readNullTerminatedString(payload, cursor);
    cursor = parsed.next;
    exports.push({
      index: i,
      characterId,
      exportName: parsed.value,
    });
  }
  return {
    count,
    exports,
    bytesConsumed: cursor,
    trailingBytes: payload.length - cursor,
  };
}

function parseDefineSprite(payload) {
  if (payload.length < 4) {
    throw new Error("DefineSprite payload too small");
  }
  const spriteId = payload.readUInt16LE(0);
  const frameCount = payload.readUInt16LE(2);
  const nestedTags = [];
  let cursor = 4;
  let reachedEnd = false;

  while (cursor + 2 <= payload.length) {
    const nestedHeaderOffset = cursor;
    const recordHeader = payload.readUInt16LE(cursor);
    cursor += 2;
    const nestedCode = recordHeader >> 6;
    let nestedLength = recordHeader & 0x3f;
    let nestedHeaderSize = 2;
    if (nestedLength === 0x3f) {
      if (cursor + 4 > payload.length) {
        throw new Error("DefineSprite nested tag long header truncated");
      }
      nestedLength = payload.readUInt32LE(cursor);
      cursor += 4;
      nestedHeaderSize = 6;
    }
    if (cursor + nestedLength > payload.length) {
      throw new Error("DefineSprite nested tag length overrun");
    }
    nestedTags.push({
      index: nestedTags.length,
      code: nestedCode,
      name: tagName(nestedCode),
      headerOffset: nestedHeaderOffset,
      headerSize: nestedHeaderSize,
      payloadOffset: cursor,
      payloadLength: nestedLength,
      endOffset: cursor + nestedLength,
    });
    cursor += nestedLength;
    if (nestedCode === 0) {
      reachedEnd = true;
      break;
    }
  }

  return {
    spriteId,
    frameCount,
    nestedTagCount: nestedTags.length,
    nestedReachedEnd: reachedEnd,
    nestedTags,
    bytesConsumed: cursor,
    trailingBytes: payload.length - cursor,
  };
}

function parseJpeg2(payload) {
  if (payload.length < 2) {
    throw new Error("DefineBitsJPEG2 payload too small");
  }
  const characterId = payload.readUInt16LE(0);
  const imageData = payload.subarray(2);
  return {
    characterId,
    imageData,
    imageDataLength: imageData.length,
    imageExtension: detectBinaryExtension(imageData),
  };
}

function parseJpeg3(payload) {
  if (payload.length < 6) {
    throw new Error("DefineBitsJPEG3 payload too small");
  }
  const characterId = payload.readUInt16LE(0);
  const alphaDataOffset = payload.readUInt32LE(2);
  const imageStart = 6;
  const imageEnd = imageStart + alphaDataOffset;
  if (imageEnd > payload.length) {
    throw new Error("DefineBitsJPEG3 alphaDataOffset overrun");
  }
  const imageData = payload.subarray(imageStart, imageEnd);
  const alphaData = payload.subarray(imageEnd);
  return {
    characterId,
    alphaDataOffset,
    imageData,
    alphaData,
    imageDataLength: imageData.length,
    alphaDataLength: alphaData.length,
    imageExtension: detectBinaryExtension(imageData),
  };
}

function parseJpeg4(payload) {
  if (payload.length < 8) {
    throw new Error("DefineBitsJPEG4 payload too small");
  }
  const characterId = payload.readUInt16LE(0);
  const alphaDataOffset = payload.readUInt32LE(2);
  const deblockParam = payload.readUInt16LE(6);
  const imageStart = 8;
  const imageEnd = imageStart + alphaDataOffset;
  if (imageEnd > payload.length) {
    throw new Error("DefineBitsJPEG4 alphaDataOffset overrun");
  }
  const imageData = payload.subarray(imageStart, imageEnd);
  const alphaData = payload.subarray(imageEnd);
  return {
    characterId,
    alphaDataOffset,
    deblockParam,
    imageData,
    alphaData,
    imageDataLength: imageData.length,
    alphaDataLength: alphaData.length,
    imageExtension: detectBinaryExtension(imageData),
  };
}

function parseLossless(payload, tagCode) {
  if (payload.length < 7) {
    throw new Error("DefineBitsLossless payload too small");
  }
  const characterId = payload.readUInt16LE(0);
  const bitmapFormat = payload[2];
  const width = payload.readUInt16LE(3);
  const height = payload.readUInt16LE(5);
  const hasColorTable = bitmapFormat === 3;
  const colorTableSize = hasColorTable ? payload[7] + 1 : null;
  const headerLength = hasColorTable ? 8 : 7;
  if (payload.length < headerLength) {
    throw new Error("DefineBitsLossless header truncated");
  }
  const zlibBitmapData = payload.subarray(headerLength);
  let decompressedLength = null;
  let decompressionError = null;
  try {
    decompressedLength = zlib.inflateSync(zlibBitmapData).length;
  } catch (err) {
    decompressionError = String(err && err.message ? err.message : err);
  }
  return {
    tagCode,
    characterId,
    bitmapFormat,
    width,
    height,
    colorTableSize,
    headerLength,
    zlibBitmapData,
    zlibBitmapDataLength: zlibBitmapData.length,
    decompressedLength,
    decompressionError,
  };
}

function relativeTo(base, target) {
  return toPosix(path.relative(base, target));
}

function createArtifactWriter(outputRoot, artifacts, runStats) {
  return function emitArtifact(kind, relPath, data, source) {
    const absolute = path.join(outputRoot, relPath);
    ensureDir(path.dirname(absolute));
    const buffer = Buffer.isBuffer(data) ? data : Buffer.from(String(data), "utf8");
    const hash = sha256(buffer);
    let action = "written";
    if (fs.existsSync(absolute)) {
      const current = fs.readFileSync(absolute);
      const currentHash = sha256(current);
      if (currentHash === hash) {
        action = "skipped";
      } else {
        fs.writeFileSync(absolute, buffer);
      }
    } else {
      fs.writeFileSync(absolute, buffer);
    }
    if (action === "written") {
      runStats.written += 1;
    } else {
      runStats.skipped += 1;
    }
    artifacts.push({
      kind,
      path: toPosix(relPath),
      sha256: hash,
      size: buffer.length,
      sourceTagIndex: source && Number.isInteger(source.tagIndex) ? source.tagIndex : null,
      sourceTagCode: source && Number.isInteger(source.tagCode) ? source.tagCode : null,
      sourceTagName: source && source.tagName ? source.tagName : null,
      sourceOffset: source && Number.isInteger(source.payloadOffset) ? source.payloadOffset : null,
    });
    return {
      relPath: toPosix(relPath),
      absPath: absolute,
      sha256: hash,
      size: buffer.length,
      action,
    };
  };
}

function stableJson(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function parseSwf(raw) {
  if (raw.length < 8) {
    throw new Error("File too small for SWF header");
  }
  const signature = raw.subarray(0, 3).toString("ascii");
  const version = raw[3];
  const declaredFileLength = raw.readUInt32LE(4);

  if (!["FWS", "CWS"].includes(signature)) {
    throw new Error(`Unsupported SWF signature: ${signature}`);
  }

  let body;
  if (signature === "FWS") {
    body = raw.subarray(8);
  } else {
    body = zlib.inflateSync(raw.subarray(8));
  }

  const expectedBodyLength = declaredFileLength - 8;
  const bodyLengthMatches = body.length === expectedBodyLength;
  if (!bodyLengthMatches) {
    throw new Error(
      `Body length mismatch: expected ${expectedBodyLength}, got ${body.length}`
    );
  }

  const uncompressed = Buffer.concat([
    Buffer.from("FWS", "ascii"),
    Buffer.from([version]),
    raw.subarray(4, 8),
    body,
  ]);

  const frameRectLength = rectByteLength(uncompressed, 8);
  const frameRateOffset = 8 + frameRectLength;
  const frameCountOffset = frameRateOffset + 2;
  const tagStart = frameCountOffset + 2;

  if (tagStart > uncompressed.length) {
    throw new Error("SWF header appears truncated before tags");
  }

  const frameRateRaw = uncompressed.readUInt16LE(frameRateOffset);
  const frameRate = frameRateRaw / 256;
  const frameCount = uncompressed.readUInt16LE(frameCountOffset);

  return {
    signature,
    version,
    declaredFileLength,
    compressedFileLength: raw.length,
    bodyLength: body.length,
    expectedBodyLength,
    uncompressed,
    frameRectLength,
    frameRateRaw,
    frameRate,
    frameCount,
    tagStart,
  };
}

function main() {
  const args = parseArgs(process.argv);
  if (args.help) {
    console.log(usage());
    return;
  }

  const inputPath = path.resolve(args.input);
  const outputRoot = path.resolve(args.out);
  if (!fs.existsSync(inputPath)) {
    throw new Error(`Input SWF not found: ${inputPath}`);
  }

  ensureDir(outputRoot);
  ensureDir(path.join(outputRoot, "swf"));
  ensureDir(path.join(outputRoot, "tags", "raw"));
  ensureDir(path.join(outputRoot, "tags", "typed"));
  ensureDir(path.join(outputRoot, "assets"));
  ensureDir(path.join(outputRoot, "maps"));
  ensureDir(path.join(outputRoot, "manifest"));

  const raw = fs.readFileSync(inputPath);
  const inputHash = sha256(raw);
  const swf = parseSwf(raw);

  const artifacts = [];
  const runStats = { written: 0, skipped: 0 };
  const emitArtifact = createArtifactWriter(outputRoot, artifacts, runStats);
  const tagRows = [];
  const parseErrors = [];
  const symbolClassBindings = [];
  const exportAssetsMap = [];
  const characterDefinitions = [];
  const spriteSummaries = [];

  emitArtifact("swf_original", "swf/original.swf", raw, {
    tagIndex: null,
    tagCode: null,
    tagName: "SWF",
    payloadOffset: null,
  });
  emitArtifact("swf_uncompressed", "swf/uncompressed.swf", swf.uncompressed, {
    tagIndex: null,
    tagCode: null,
    tagName: "SWF",
    payloadOffset: null,
  });

  const swfHeaderMeta = {
    inputPath,
    inputHashSha256: inputHash,
    signatureOriginal: swf.signature,
    signatureLogical: "FWS",
    version: swf.version,
    declaredFileLength: swf.declaredFileLength,
    compressedFileLength: swf.compressedFileLength,
    decompressedBodyLength: swf.bodyLength,
    frameRectLengthBytes: swf.frameRectLength,
    frameRateFixed8Raw: swf.frameRateRaw,
    frameRate: swf.frameRate,
    frameCount: swf.frameCount,
    tagStartOffset: swf.tagStart,
  };
  emitArtifact(
    "swf_header_metadata",
    "swf/header.json",
    stableJson(swfHeaderMeta),
    {
      tagIndex: null,
      tagCode: null,
      tagName: "SWF",
      payloadOffset: null,
    }
  );

  let offset = swf.tagStart;
  let tagIndex = 0;
  let reachedEnd = false;
  let integrityError = null;

  while (offset + 2 <= swf.uncompressed.length) {
    const headerOffset = offset;
    const tagCodeAndLength = swf.uncompressed.readUInt16LE(offset);
    offset += 2;
    const code = tagCodeAndLength >> 6;
    let payloadLength = tagCodeAndLength & 0x3f;
    let headerSize = 2;

    if (payloadLength === 0x3f) {
      if (offset + 4 > swf.uncompressed.length) {
        integrityError = `Tag ${tagIndex} long header truncated`;
        break;
      }
      payloadLength = swf.uncompressed.readUInt32LE(offset);
      offset += 4;
      headerSize = 6;
    }

    const payloadOffset = offset;
    const endOffset = payloadOffset + payloadLength;
    if (endOffset > swf.uncompressed.length) {
      integrityError = `Tag ${tagIndex} payload overrun (end ${endOffset} > ${swf.uncompressed.length})`;
      break;
    }

    const payload = swf.uncompressed.subarray(payloadOffset, endOffset);
    const name = tagName(code);
    const safeName = sanitizeSegment(name.toLowerCase());
    const rawTagPath = `tags/raw/tag_${pad(tagIndex, 4)}_${pad(code, 3)}_${safeName}.bin`;
    const rawArtifact = emitArtifact("tag_raw_payload", rawTagPath, payload, {
      tagIndex,
      tagCode: code,
      tagName: name,
      payloadOffset,
    });

    const tagRow = {
      index: tagIndex,
      code,
      name,
      headerOffset,
      headerSize,
      payloadOffset,
      payloadLength,
      endOffset,
      rawPayloadPath: rawArtifact.relPath,
      rawPayloadSha256: rawArtifact.sha256,
      typedPaths: [],
      assetPaths: [],
      parseStatus: "not_typed",
      parseError: null,
    };

    if (CHARACTER_ID_TAGS.has(code) && payload.length >= 2) {
      characterDefinitions.push({
        characterId: payload.readUInt16LE(0),
        definedByTagIndex: tagIndex,
        tagCode: code,
        tagName: name,
      });
    }

    try {
      if (code === 82 || code === 72) {
        const typed = parseDoABC(payload);
        const baseName = sanitizeSegment(typed.name || `tag_${tagIndex}`);
        const typedPath = `tags/typed/tag_${pad(tagIndex, 4)}_${pad(code, 3)}_${safeName}.json`;
        const abcPath = `assets/doabc/tag_${pad(tagIndex, 4)}_${baseName}.abc`;
        const abcArtifact = emitArtifact("doabc_abc", abcPath, typed.abcData, {
          tagIndex,
          tagCode: code,
          tagName: name,
          payloadOffset,
        });
        const typedDoc = {
          tagIndex,
          tagCode: code,
          tagName: name,
          flags: typed.flags,
          lazyInitialize: typed.lazyInitialize,
          scriptName: typed.name,
          abcDataOffset: typed.abcDataOffset,
          abcDataLength: typed.abcDataLength,
          abcArtifactPath: abcArtifact.relPath,
          abcSha256: abcArtifact.sha256,
        };
        const typedArtifact = emitArtifact(
          "typed_doabc_json",
          typedPath,
          stableJson(typedDoc),
          { tagIndex, tagCode: code, tagName: name, payloadOffset }
        );
        tagRow.typedPaths.push(typedArtifact.relPath);
        tagRow.assetPaths.push(abcArtifact.relPath);
        tagRow.parseStatus = "ok";
      } else if (code === 87) {
        const typed = parseDefineBinaryData(payload);
        const typedPath = `tags/typed/tag_${pad(tagIndex, 4)}_${pad(code, 3)}_${safeName}.json`;
        const dataExt = detectBinaryExtension(typed.data);
        const dataPath = `assets/definebinarydata/tag_${pad(tagIndex, 4)}_char_${pad(
          typed.characterId,
          5
        )}.${dataExt}`;
        const dataArtifact = emitArtifact("definebinarydata_data", dataPath, typed.data, {
          tagIndex,
          tagCode: code,
          tagName: name,
          payloadOffset,
        });
        const typedDoc = {
          tagIndex,
          tagCode: code,
          tagName: name,
          characterId: typed.characterId,
          reserved: typed.reserved,
          dataLength: typed.dataLength,
          dataArtifactPath: dataArtifact.relPath,
          dataSha256: dataArtifact.sha256,
        };
        const typedArtifact = emitArtifact(
          "typed_definebinarydata_json",
          typedPath,
          stableJson(typedDoc),
          { tagIndex, tagCode: code, tagName: name, payloadOffset }
        );
        tagRow.typedPaths.push(typedArtifact.relPath);
        tagRow.assetPaths.push(dataArtifact.relPath);
        tagRow.parseStatus = "ok";
      } else if (code === 76) {
        const typed = parseSymbolClass(payload);
        const typedPath = `tags/typed/tag_${pad(tagIndex, 4)}_${pad(code, 3)}_${safeName}.json`;
        const typedDoc = {
          tagIndex,
          tagCode: code,
          tagName: name,
          count: typed.count,
          bytesConsumed: typed.bytesConsumed,
          trailingBytes: typed.trailingBytes,
          symbols: typed.symbols,
        };
        const typedArtifact = emitArtifact(
          "typed_symbolclass_json",
          typedPath,
          stableJson(typedDoc),
          { tagIndex, tagCode: code, tagName: name, payloadOffset }
        );
        for (const symbol of typed.symbols) {
          symbolClassBindings.push({
            tagIndex,
            characterId: symbol.characterId,
            className: symbol.className,
          });
        }
        tagRow.typedPaths.push(typedArtifact.relPath);
        tagRow.parseStatus = "ok";
      } else if (code === 56) {
        const typed = parseExportAssets(payload);
        const typedPath = `tags/typed/tag_${pad(tagIndex, 4)}_${pad(code, 3)}_${safeName}.json`;
        const typedDoc = {
          tagIndex,
          tagCode: code,
          tagName: name,
          count: typed.count,
          bytesConsumed: typed.bytesConsumed,
          trailingBytes: typed.trailingBytes,
          exports: typed.exports,
        };
        const typedArtifact = emitArtifact(
          "typed_exportassets_json",
          typedPath,
          stableJson(typedDoc),
          { tagIndex, tagCode: code, tagName: name, payloadOffset }
        );
        for (const exp of typed.exports) {
          exportAssetsMap.push({
            tagIndex,
            characterId: exp.characterId,
            exportName: exp.exportName,
          });
        }
        tagRow.typedPaths.push(typedArtifact.relPath);
        tagRow.parseStatus = "ok";
      } else if (code === 39) {
        const typed = parseDefineSprite(payload);
        const typedPath = `tags/typed/tag_${pad(tagIndex, 4)}_${pad(code, 3)}_${safeName}.json`;
        const typedDoc = {
          tagIndex,
          tagCode: code,
          tagName: name,
          spriteId: typed.spriteId,
          frameCount: typed.frameCount,
          nestedTagCount: typed.nestedTagCount,
          nestedReachedEnd: typed.nestedReachedEnd,
          bytesConsumed: typed.bytesConsumed,
          trailingBytes: typed.trailingBytes,
          nestedTags: typed.nestedTags,
        };
        const typedArtifact = emitArtifact(
          "typed_definesprite_json",
          typedPath,
          stableJson(typedDoc),
          { tagIndex, tagCode: code, tagName: name, payloadOffset }
        );
        spriteSummaries.push({
          tagIndex,
          spriteId: typed.spriteId,
          frameCount: typed.frameCount,
          nestedTagCount: typed.nestedTagCount,
          nestedReachedEnd: typed.nestedReachedEnd,
        });
        tagRow.typedPaths.push(typedArtifact.relPath);
        tagRow.parseStatus = "ok";
      } else if (code === 21) {
        const typed = parseJpeg2(payload);
        const typedPath = `tags/typed/tag_${pad(tagIndex, 4)}_${pad(code, 3)}_${safeName}.json`;
        const imagePath = `assets/definebitsjpeg2/tag_${pad(tagIndex, 4)}_char_${pad(
          typed.characterId,
          5
        )}.${typed.imageExtension}`;
        const imageArtifact = emitArtifact("definebitsjpeg2_image", imagePath, typed.imageData, {
          tagIndex,
          tagCode: code,
          tagName: name,
          payloadOffset,
        });
        const typedArtifact = emitArtifact(
          "typed_definebitsjpeg2_json",
          typedPath,
          stableJson({
            tagIndex,
            tagCode: code,
            tagName: name,
            characterId: typed.characterId,
            imageDataLength: typed.imageDataLength,
            imageExtension: typed.imageExtension,
            imageArtifactPath: imageArtifact.relPath,
            imageSha256: imageArtifact.sha256,
          }),
          { tagIndex, tagCode: code, tagName: name, payloadOffset }
        );
        tagRow.typedPaths.push(typedArtifact.relPath);
        tagRow.assetPaths.push(imageArtifact.relPath);
        tagRow.parseStatus = "ok";
      } else if (code === 35 || code === 90) {
        const typed = code === 35 ? parseJpeg3(payload) : parseJpeg4(payload);
        const typedPath = `tags/typed/tag_${pad(tagIndex, 4)}_${pad(code, 3)}_${safeName}.json`;
        const assetFolder = code === 35 ? "definebitsjpeg3" : "definebitsjpeg4";
        const imagePath = `assets/${assetFolder}/tag_${pad(tagIndex, 4)}_char_${pad(
          typed.characterId,
          5
        )}_image.${typed.imageExtension}`;
        const alphaPath = `assets/${assetFolder}/tag_${pad(tagIndex, 4)}_char_${pad(
          typed.characterId,
          5
        )}_alpha.zlib`;
        const imageArtifact = emitArtifact(`${assetFolder}_image`, imagePath, typed.imageData, {
          tagIndex,
          tagCode: code,
          tagName: name,
          payloadOffset,
        });
        const alphaArtifact = emitArtifact(`${assetFolder}_alpha`, alphaPath, typed.alphaData, {
          tagIndex,
          tagCode: code,
          tagName: name,
          payloadOffset,
        });
        const typedDoc = {
          tagIndex,
          tagCode: code,
          tagName: name,
          characterId: typed.characterId,
          alphaDataOffset: typed.alphaDataOffset,
          imageDataLength: typed.imageDataLength,
          alphaDataLength: typed.alphaDataLength,
          imageExtension: typed.imageExtension,
          imageArtifactPath: imageArtifact.relPath,
          alphaArtifactPath: alphaArtifact.relPath,
          imageSha256: imageArtifact.sha256,
          alphaSha256: alphaArtifact.sha256,
        };
        if (code === 90) {
          typedDoc.deblockParam = typed.deblockParam;
        }
        const typedArtifact = emitArtifact(
          `typed_${assetFolder}_json`,
          typedPath,
          stableJson(typedDoc),
          { tagIndex, tagCode: code, tagName: name, payloadOffset }
        );
        tagRow.typedPaths.push(typedArtifact.relPath);
        tagRow.assetPaths.push(imageArtifact.relPath, alphaArtifact.relPath);
        tagRow.parseStatus = "ok";
      } else if (code === 20 || code === 36) {
        const typed = parseLossless(payload, code);
        const typedPath = `tags/typed/tag_${pad(tagIndex, 4)}_${pad(code, 3)}_${safeName}.json`;
        const folder = code === 20 ? "definebitslossless" : "definebitslossless2";
        const zlibPath = `assets/${folder}/tag_${pad(tagIndex, 4)}_char_${pad(
          typed.characterId,
          5
        )}_bitmap.zlib`;
        const zlibArtifact = emitArtifact(`${folder}_bitmap_zlib`, zlibPath, typed.zlibBitmapData, {
          tagIndex,
          tagCode: code,
          tagName: name,
          payloadOffset,
        });
        let inflatedArtifact = null;
        if (typed.decompressionError === null) {
          const inflated = zlib.inflateSync(typed.zlibBitmapData);
          const rawPath = `assets/${folder}/tag_${pad(tagIndex, 4)}_char_${pad(
            typed.characterId,
            5
          )}_bitmap.raw`;
          inflatedArtifact = emitArtifact(`${folder}_bitmap_raw`, rawPath, inflated, {
            tagIndex,
            tagCode: code,
            tagName: name,
            payloadOffset,
          });
          tagRow.assetPaths.push(inflatedArtifact.relPath);
        }
        const typedDoc = {
          tagIndex,
          tagCode: code,
          tagName: name,
          characterId: typed.characterId,
          bitmapFormat: typed.bitmapFormat,
          width: typed.width,
          height: typed.height,
          colorTableSize: typed.colorTableSize,
          headerLength: typed.headerLength,
          zlibBitmapDataLength: typed.zlibBitmapDataLength,
          zlibArtifactPath: zlibArtifact.relPath,
          zlibSha256: zlibArtifact.sha256,
          decompressedLength: typed.decompressedLength,
          decompressionError: typed.decompressionError,
          inflatedArtifactPath: inflatedArtifact ? inflatedArtifact.relPath : null,
          inflatedSha256: inflatedArtifact ? inflatedArtifact.sha256 : null,
        };
        const typedArtifact = emitArtifact(
          `typed_${folder}_json`,
          typedPath,
          stableJson(typedDoc),
          { tagIndex, tagCode: code, tagName: name, payloadOffset }
        );
        tagRow.typedPaths.push(typedArtifact.relPath);
        tagRow.assetPaths.push(zlibArtifact.relPath);
        tagRow.parseStatus = "ok";
      }
    } catch (err) {
      const message = String(err && err.message ? err.message : err);
      tagRow.parseStatus = "error";
      tagRow.parseError = message;
      parseErrors.push({
        tagIndex,
        tagCode: code,
        tagName: name,
        payloadOffset,
        payloadLength,
        error: message,
      });
    }

    tagRows.push(tagRow);
    offset = endOffset;
    tagIndex += 1;

    if (code === 0) {
      reachedEnd = true;
      break;
    }
  }

  if (!reachedEnd && integrityError === null) {
    integrityError = "Did not encounter End tag before stream termination";
  }

  const tagsJsonlBuffer = Buffer.from(
    tagRows.map((row) => JSON.stringify(row)).join("\n").concat("\n"),
    "utf8"
  );
  emitArtifact("manifest_tags_jsonl", "manifest/tags.jsonl", tagsJsonlBuffer, {
    tagIndex: null,
    tagCode: null,
    tagName: "MANIFEST",
    payloadOffset: null,
  });

  const classBindingsSorted = [...symbolClassBindings].sort((a, b) => {
    if (a.characterId !== b.characterId) return a.characterId - b.characterId;
    if (a.className !== b.className) return a.className.localeCompare(b.className);
    return a.tagIndex - b.tagIndex;
  });
  emitArtifact(
    "map_class_bindings_json",
    "maps/class_bindings.json",
    stableJson({
      count: classBindingsSorted.length,
      bindings: classBindingsSorted,
    }),
    { tagIndex: null, tagCode: null, tagName: "MAP", payloadOffset: null }
  );

  const exportAssetsSorted = [...exportAssetsMap].sort((a, b) => {
    if (a.characterId !== b.characterId) return a.characterId - b.characterId;
    if (a.exportName !== b.exportName) return a.exportName.localeCompare(b.exportName);
    return a.tagIndex - b.tagIndex;
  });
  emitArtifact(
    "map_export_assets_json",
    "maps/exported_symbols.json",
    stableJson({
      count: exportAssetsSorted.length,
      exports: exportAssetsSorted,
    }),
    { tagIndex: null, tagCode: null, tagName: "MAP", payloadOffset: null }
  );

  const characterIndex = new Map();
  for (const def of characterDefinitions) {
    const key = String(def.characterId);
    if (!characterIndex.has(key)) {
      characterIndex.set(key, {
        characterId: def.characterId,
        definitions: [],
        classBindings: [],
        exportNames: [],
      });
    }
    characterIndex.get(key).definitions.push({
      tagIndex: def.definedByTagIndex,
      tagCode: def.tagCode,
      tagName: def.tagName,
    });
  }
  for (const b of classBindingsSorted) {
    const key = String(b.characterId);
    if (!characterIndex.has(key)) {
      characterIndex.set(key, {
        characterId: b.characterId,
        definitions: [],
        classBindings: [],
        exportNames: [],
      });
    }
    characterIndex.get(key).classBindings.push({
      tagIndex: b.tagIndex,
      className: b.className,
    });
  }
  for (const e of exportAssetsSorted) {
    const key = String(e.characterId);
    if (!characterIndex.has(key)) {
      characterIndex.set(key, {
        characterId: e.characterId,
        definitions: [],
        classBindings: [],
        exportNames: [],
      });
    }
    characterIndex.get(key).exportNames.push({
      tagIndex: e.tagIndex,
      exportName: e.exportName,
    });
  }

  const characterIndexRows = [...characterIndex.values()].sort(
    (a, b) => a.characterId - b.characterId
  );
  emitArtifact(
    "map_character_index_json",
    "maps/character_id_index.json",
    stableJson({
      count: characterIndexRows.length,
      entries: characterIndexRows,
    }),
    { tagIndex: null, tagCode: null, tagName: "MAP", payloadOffset: null }
  );

  emitArtifact(
    "map_sprites_json",
    "maps/sprites.json",
    stableJson({
      count: spriteSummaries.length,
      sprites: spriteSummaries.sort((a, b) => a.spriteId - b.spriteId),
    }),
    { tagIndex: null, tagCode: null, tagName: "MAP", payloadOffset: null }
  );

  const artifactsJsonlBuffer = Buffer.from(
    artifacts.map((a) => JSON.stringify(a)).join("\n").concat("\n"),
    "utf8"
  );
  emitArtifact("manifest_artifacts_jsonl", "manifest/artifacts.jsonl", artifactsJsonlBuffer, {
    tagIndex: null,
    tagCode: null,
    tagName: "MANIFEST",
    payloadOffset: null,
  });

  const tagsWithErrors = tagRows.filter((t) => t.parseStatus === "error").length;
  const doAbcCount = tagRows.filter((t) => t.code === 82 || t.code === 72).length;
  const defineBinaryCount = tagRows.filter((t) => t.code === 87).length;
  const doAbcWithArtifacts = tagRows.filter(
    (t) => (t.code === 82 || t.code === 72) && t.assetPaths.length > 0
  ).length;
  const defineBinaryWithArtifacts = tagRows.filter(
    (t) => t.code === 87 && t.assetPaths.length > 0
  ).length;

  const summary = {
    input: {
      path: inputPath,
      sha256: inputHash,
      signatureOriginal: swf.signature,
      version: swf.version,
      declaredFileLength: swf.declaredFileLength,
      compressedFileLength: swf.compressedFileLength,
      decompressedBodyLength: swf.bodyLength,
    },
    outputRoot,
    integrity: {
      decompressedBodyLengthMatchesHeader: swf.bodyLength === swf.expectedBodyLength,
      tagWalkReachedEndTag: reachedEnd,
      tagWalkIntegrityError: integrityError,
    },
    completeness: {
      parsedTagCount: tagRows.length,
      rawTagPayloadExportCount: tagRows.length,
      doAbcTagCount: doAbcCount,
      doAbcWithExtractedArtifacts: doAbcWithArtifacts,
      defineBinaryDataTagCount: defineBinaryCount,
      defineBinaryDataWithExtractedArtifacts: defineBinaryWithArtifacts,
      parseErrorCount: tagsWithErrors,
      parseErrors,
    },
    reproducibility: {
      totalArtifacts: artifacts.length,
      deterministicNaming: true,
      contentAddressedBySha256: true,
    },
    manifests: {
      summary: "manifest/summary.json",
      tagsJsonl: "manifest/tags.jsonl",
      artifactsJsonl: "manifest/artifacts.jsonl",
    },
  };

  emitArtifact("manifest_summary_json", "manifest/summary.json", stableJson(summary), {
    tagIndex: null,
    tagCode: null,
    tagName: "MANIFEST",
    payloadOffset: null,
  });

  if (integrityError) {
    process.exitCode = 2;
  }

  console.log(
    JSON.stringify(
      {
        ...summary,
        run: {
          artifactsWrittenThisRun: runStats.written,
          artifactsSkippedThisRun: runStats.skipped,
        },
      },
      null,
      2
    )
  );
}

try {
  main();
} catch (err) {
  console.error(`[extract-cda-swf] ${err && err.message ? err.message : err}`);
  process.exitCode = 1;
}
