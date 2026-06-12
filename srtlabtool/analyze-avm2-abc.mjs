#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

const DEFAULT_ROOT =
  "C:\\Users\\gomez\\Documents\\Codex\\2026-05-20\\files-mentioned-by-the-user-srt\\cda_extracted";
const DEFAULT_ABC_REL = "assets/doabc/tag_0367_frame2.abc";

const TRAIT_KIND = {
  0: "slot",
  1: "method",
  2: "getter",
  3: "setter",
  4: "class",
  5: "function",
  6: "const",
};

const NS_KIND = {
  0x05: "PrivateNs",
  0x08: "Namespace",
  0x16: "PackageNamespace",
  0x17: "PackageInternalNs",
  0x18: "ProtectedNamespace",
  0x19: "ExplicitNamespace",
  0x1a: "StaticProtectedNs",
};

class ByteReader {
  constructor(buffer) {
    this.buffer = buffer;
    this.pos = 0;
  }

  ensure(n) {
    if (this.pos + n > this.buffer.length) {
      throw new Error(
        `Read out of bounds at ${this.pos} (+${n}), length=${this.buffer.length}`
      );
    }
  }

  u8() {
    this.ensure(1);
    const v = this.buffer[this.pos];
    this.pos += 1;
    return v;
  }

  u16() {
    this.ensure(2);
    const v = this.buffer.readUInt16LE(this.pos);
    this.pos += 2;
    return v;
  }

  u32Var() {
    let result = 0;
    for (let i = 0; i < 5; i += 1) {
      const b = this.u8();
      if (i === 4) {
        result |= b << 28;
        return result >>> 0;
      }
      result |= (b & 0x7f) << (7 * i);
      if ((b & 0x80) === 0) {
        return result >>> 0;
      }
    }
    throw new Error(`Invalid variable-length integer at ${this.pos}`);
  }

  u30() {
    return this.u32Var() & 0x3fffffff;
  }

  s32Var() {
    const u = this.u32Var();
    return u | 0;
  }

  bytes(n) {
    this.ensure(n);
    const v = this.buffer.subarray(this.pos, this.pos + n);
    this.pos += n;
    return v;
  }

  f64() {
    this.ensure(8);
    const v = this.buffer.readDoubleLE(this.pos);
    this.pos += 8;
    return v;
  }
}

function parseArgs(argv) {
  const parsed = {
    root: DEFAULT_ROOT,
    abc: null,
    outPrefix: "",
    emitBytecodeLines: false,
  };
  for (let i = 2; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--root" && argv[i + 1]) {
      parsed.root = argv[i + 1];
      i += 1;
    } else if (arg === "--abc" && argv[i + 1]) {
      parsed.abc = argv[i + 1];
      i += 1;
    } else if (arg === "--out-prefix" && argv[i + 1]) {
      parsed.outPrefix = argv[i + 1];
      i += 1;
    } else if (arg === "--emit-bytecode-lines") {
      parsed.emitBytecodeLines = true;
    } else if (arg === "--help" || arg === "-h") {
      parsed.help = true;
    }
  }
  return parsed;
}

function usage() {
  return [
    "Usage:",
    "  node analyze-avm2-abc.mjs [--root <cda_extracted>] [--abc <path-to-abc>] [--out-prefix <prefix>] [--emit-bytecode-lines]",
    "",
    `Default root: ${DEFAULT_ROOT}`,
    `Default abc: ${DEFAULT_ABC_REL}`,
  ].join("\n");
}

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function stableWrite(file, content) {
  const next = Buffer.from(content, "utf8");
  if (fs.existsSync(file)) {
    const prev = fs.readFileSync(file);
    if (Buffer.compare(prev, next) === 0) {
      return "skipped";
    }
  }
  fs.writeFileSync(file, next);
  return "written";
}

function normalizeQualifiedName(s) {
  if (!s) return "";
  return s
    .replace(/::/g, ".")
    .replace(/[^\w.$]+/g, ".")
    .replace(/\.+/g, ".")
    .replace(/^\./, "")
    .replace(/\.$/, "");
}

function likelyDomainBucket(name) {
  const n = (name || "").toLowerCase();
  if (n.includes("buslog")) return "buslog";
  if (n.includes("proxi")) return "proxi";
  if (n.includes("diagnostic") || n.includes("diag")) return "diagnostic";
  if (n.includes("ecu")) return "ecu";
  if (n.includes("flash")) return "flash";
  if (n.includes("unlock")) return "unlock";
  if (n.includes("dtc")) return "dtc";
  if (n.includes("sync")) return "sync";
  if (n.includes("auth")) return "auth";
  if (n.includes("tracer")) return "tracer";
  return "other";
}

function parseMetadata(reader, strings) {
  const count = reader.u30();
  const metadata = [];
  for (let i = 0; i < count; i += 1) {
    const name = reader.u30();
    const itemCount = reader.u30();
    const keys = [];
    const values = [];
    for (let j = 0; j < itemCount; j += 1) {
      keys.push(reader.u30());
    }
    for (let j = 0; j < itemCount; j += 1) {
      values.push(reader.u30());
    }
    metadata.push({
      index: i,
      nameIndex: name,
      name: strings[name] ?? "",
      items: keys.map((k, idx) => ({
        keyIndex: k,
        key: strings[k] ?? "",
        valueIndex: values[idx],
        value: strings[values[idx]] ?? "",
      })),
    });
  }
  return metadata;
}

function parseConstantPool(reader) {
  const ints = [0];
  const intCount = reader.u30();
  for (let i = 1; i < intCount; i += 1) ints.push(reader.s32Var());

  const uints = [0];
  const uintCount = reader.u30();
  for (let i = 1; i < uintCount; i += 1) uints.push(reader.u32Var());

  const doubles = [Number.NaN];
  const doubleCount = reader.u30();
  for (let i = 1; i < doubleCount; i += 1) doubles.push(reader.f64());

  const strings = [""];
  const stringCount = reader.u30();
  for (let i = 1; i < stringCount; i += 1) {
    const len = reader.u30();
    strings.push(reader.bytes(len).toString("utf8"));
  }

  const namespaces = [{ kind: 0, kindName: "any", nameIndex: 0, uri: "" }];
  const namespaceCount = reader.u30();
  for (let i = 1; i < namespaceCount; i += 1) {
    const kind = reader.u8();
    const nameIndex = reader.u30();
    namespaces.push({
      kind,
      kindName: NS_KIND[kind] || `NamespaceKind_${kind}`,
      nameIndex,
      uri: strings[nameIndex] ?? "",
    });
  }

  const nsSets = [[]];
  const nsSetCount = reader.u30();
  for (let i = 1; i < nsSetCount; i += 1) {
    const count = reader.u30();
    const items = [];
    for (let j = 0; j < count; j += 1) items.push(reader.u30());
    nsSets.push(items);
  }

  const multinames = [{ kind: 0, kindName: "any" }];
  const multinameCount = reader.u30();
  for (let i = 1; i < multinameCount; i += 1) {
    const kind = reader.u8();
    const rec = {
      index: i,
      kind,
      kindName: `MultinameKind_${kind.toString(16)}`,
    };
    switch (kind) {
      case 0x07: // QName
      case 0x0d: // QNameA
        rec.kindName = kind === 0x07 ? "QName" : "QNameA";
        rec.ns = reader.u30();
        rec.name = reader.u30();
        break;
      case 0x0f: // RTQName
      case 0x10: // RTQNameA
        rec.kindName = kind === 0x0f ? "RTQName" : "RTQNameA";
        rec.name = reader.u30();
        break;
      case 0x11: // RTQNameL
      case 0x12: // RTQNameLA
        rec.kindName = kind === 0x11 ? "RTQNameL" : "RTQNameLA";
        break;
      case 0x09: // Multiname
      case 0x0e: // MultinameA
        rec.kindName = kind === 0x09 ? "Multiname" : "MultinameA";
        rec.name = reader.u30();
        rec.nsSet = reader.u30();
        break;
      case 0x1b: // MultinameL
      case 0x1c: // MultinameLA
        rec.kindName = kind === 0x1b ? "MultinameL" : "MultinameLA";
        rec.nsSet = reader.u30();
        break;
      case 0x1d: // TypeName
        rec.kindName = "TypeName";
        rec.qname = reader.u30();
        rec.paramCount = reader.u30();
        rec.params = [];
        for (let p = 0; p < rec.paramCount; p += 1) rec.params.push(reader.u30());
        break;
      default:
        throw new Error(`Unsupported multiname kind 0x${kind.toString(16)} at index ${i}`);
    }
    multinames.push(rec);
  }

  return {
    ints,
    uints,
    doubles,
    strings,
    namespaces,
    nsSets,
    multinames,
  };
}

function makeResolvers(cp) {
  const multinameCache = new Map();

  function stringAt(index) {
    return cp.strings[index] ?? "";
  }

  function namespaceAt(index) {
    return cp.namespaces[index] ?? cp.namespaces[0];
  }

  function namespaceText(index) {
    if (index === 0) return "*";
    const ns = namespaceAt(index);
    if (!ns) return `#ns${index}`;
    if (ns.uri) return ns.uri;
    if (ns.kindName === "PrivateNs") return "PrivateNs";
    if (
      ns.kindName === "PackageNamespace" ||
      ns.kindName === "PackageInternalNs" ||
      ns.kindName === "Namespace"
    ) {
      return "";
    }
    return ns.kindName || "";
  }

  function nsSetText(index) {
    const set = cp.nsSets[index] ?? [];
    return set.map((nsIdx) => namespaceText(nsIdx));
  }

  function multinameText(index, depth = 0) {
    if (index === 0) return "*";
    if (depth > 10) return `#mn${index}`;
    if (multinameCache.has(index)) return multinameCache.get(index);

    const mn = cp.multinames[index];
    if (!mn) return `#mn${index}`;

    let out = `#mn${index}`;
    switch (mn.kind) {
      case 0x07:
      case 0x0d: {
        const ns = namespaceText(mn.ns);
        const name = stringAt(mn.name) || "*";
        out = ns && ns !== "*" ? `${ns}.${name}` : name;
        break;
      }
      case 0x0f:
      case 0x10: {
        out = `RTQName(${stringAt(mn.name) || "*"})`;
        break;
      }
      case 0x11:
      case 0x12: {
        out = mn.kindName;
        break;
      }
      case 0x09:
      case 0x0e: {
        const name = stringAt(mn.name) || "*";
        const set = nsSetText(mn.nsSet).filter(Boolean);
        if (set.length === 1) out = `${set[0]}.${name}`;
        else if (set.length === 0) out = name;
        else out = `{${set.join("|")}}.${name}`;
        break;
      }
      case 0x1b:
      case 0x1c: {
        const set = nsSetText(mn.nsSet).filter(Boolean);
        if (set.length === 0) out = "*";
        else
        out = `{${set.join("|")}}.*`;
        break;
      }
      case 0x1d: {
        const base = multinameText(mn.qname, depth + 1);
        const params = (mn.params || []).map((p) => multinameText(p, depth + 1));
        out = `${base}<${params.join(", ")}>`;
        break;
      }
      default:
        out = mn.kindName || `#mn${index}`;
    }

    multinameCache.set(index, out);
    return out;
  }

  return {
    stringAt,
    namespaceText,
    nsSetText,
    multinameText,
  };
}

function parseTraits(reader, resolve, context) {
  const traitCount = reader.u30();
  const traits = [];
  for (let i = 0; i < traitCount; i += 1) {
    const nameIndex = reader.u30();
    const kindByte = reader.u8();
    const kind = kindByte & 0x0f;
    const attrs = kindByte >> 4;
    const trait = {
      context,
      index: i,
      nameIndex,
      name: resolve.multinameText(nameIndex),
      kind,
      kindName: TRAIT_KIND[kind] || `trait_${kind}`,
      attrs,
      metadata: [],
      data: {},
    };

    switch (kind) {
      case 0: // slot
      case 6: // const
        trait.data.slotId = reader.u30();
        trait.data.typeNameIndex = reader.u30();
        trait.data.typeName = resolve.multinameText(trait.data.typeNameIndex);
        trait.data.vindex = reader.u30();
        if (trait.data.vindex !== 0) {
          trait.data.vkind = reader.u8();
        }
        break;
      case 1: // method
      case 2: // getter
      case 3: // setter
        trait.data.dispId = reader.u30();
        trait.data.method = reader.u30();
        break;
      case 4: // class
        trait.data.slotId = reader.u30();
        trait.data.classi = reader.u30();
        break;
      case 5: // function
        trait.data.slotId = reader.u30();
        trait.data.function = reader.u30();
        break;
      default:
        throw new Error(`Unsupported trait kind ${kind} in ${context}`);
    }

    if ((attrs & 0x4) !== 0) {
      const metadataCount = reader.u30();
      for (let m = 0; m < metadataCount; m += 1) {
        trait.metadata.push(reader.u30());
      }
    }

    traits.push(trait);
  }
  return traits;
}

function decodeMethodFlags(flags) {
  return {
    NEED_ARGUMENTS: (flags & 0x01) !== 0,
    NEED_ACTIVATION: (flags & 0x02) !== 0,
    NEED_REST: (flags & 0x04) !== 0,
    HAS_OPTIONAL: (flags & 0x08) !== 0,
    SET_DXNS: (flags & 0x40) !== 0,
    HAS_PARAM_NAMES: (flags & 0x80) !== 0,
  };
}

function parseAbc(buffer, options = {}) {
  const includeCodeHex = Boolean(options.includeCodeHex);
  const reader = new ByteReader(buffer);
  const minorVersion = reader.u16();
  const majorVersion = reader.u16();

  const cp = parseConstantPool(reader);
  const resolve = makeResolvers(cp);

  const methodCount = reader.u30();
  const methods = [];
  for (let i = 0; i < methodCount; i += 1) {
    const paramCount = reader.u30();
    const returnType = reader.u30();
    const paramTypes = [];
    for (let p = 0; p < paramCount; p += 1) paramTypes.push(reader.u30());
    const nameIndex = reader.u30();
    const flags = reader.u8();
    const decodedFlags = decodeMethodFlags(flags);
    const optional = [];
    if (decodedFlags.HAS_OPTIONAL) {
      const optionCount = reader.u30();
      for (let o = 0; o < optionCount; o += 1) {
        optional.push({ val: reader.u30(), kind: reader.u8() });
      }
    }
    const paramNames = [];
    if (decodedFlags.HAS_PARAM_NAMES) {
      for (let p = 0; p < paramCount; p += 1) paramNames.push(reader.u30());
    }

    methods.push({
      index: i,
      paramCount,
      returnTypeIndex: returnType,
      returnType: resolve.multinameText(returnType),
      paramTypeIndices: paramTypes,
      paramTypes: paramTypes.map((t) => resolve.multinameText(t)),
      nameIndex,
      name: cp.strings[nameIndex] ?? "",
      flags,
      flagsDecoded: decodedFlags,
      optional,
      paramNameIndices: paramNames,
      paramNames: paramNames.map((idx) => cp.strings[idx] ?? ""),
      body: null,
      refs: [],
    });
  }

  const metadata = parseMetadata(reader, cp.strings);

  const instanceCount = reader.u30();
  const instances = [];
  for (let i = 0; i < instanceCount; i += 1) {
    const name = reader.u30();
    const superName = reader.u30();
    const flags = reader.u8();
    let protectedNs = null;
    if ((flags & 0x08) !== 0) protectedNs = reader.u30();
    const interfaceCount = reader.u30();
    const interfaces = [];
    for (let j = 0; j < interfaceCount; j += 1) interfaces.push(reader.u30());
    const iinit = reader.u30();
    const traits = parseTraits(reader, resolve, `instance[${i}]`);
    instances.push({
      index: i,
      nameIndex: name,
      name: resolve.multinameText(name),
      superNameIndex: superName,
      superName: resolve.multinameText(superName),
      flags,
      flagsDecoded: {
        sealed: (flags & 0x01) !== 0,
        final: (flags & 0x02) !== 0,
        interface: (flags & 0x04) !== 0,
        protectedNs: (flags & 0x08) !== 0,
      },
      protectedNsIndex: protectedNs,
      protectedNs: protectedNs !== null ? resolve.namespaceText(protectedNs) : null,
      interfaceIndices: interfaces,
      interfaces: interfaces.map((idx) => resolve.multinameText(idx)),
      iinit,
      traits,
    });
  }

  const classes = [];
  for (let i = 0; i < instanceCount; i += 1) {
    const cinit = reader.u30();
    const traits = parseTraits(reader, resolve, `class[${i}]`);
    classes.push({
      index: i,
      cinit,
      traits,
    });
  }

  const scriptCount = reader.u30();
  const scripts = [];
  for (let i = 0; i < scriptCount; i += 1) {
    const init = reader.u30();
    const traits = parseTraits(reader, resolve, `script[${i}]`);
    scripts.push({
      index: i,
      init,
      traits,
    });
  }

  const methodBodyCount = reader.u30();
  for (let i = 0; i < methodBodyCount; i += 1) {
    const method = reader.u30();
    const maxStack = reader.u30();
    const localCount = reader.u30();
    const initScopeDepth = reader.u30();
    const maxScopeDepth = reader.u30();
    const codeLength = reader.u30();
    const code = reader.bytes(codeLength);
    const codeHex = Buffer.from(code).toString("hex");
    const codeSha256 = crypto.createHash("sha256").update(code).digest("hex");
    const exceptionCount = reader.u30();
    const exceptions = [];
    for (let e = 0; e < exceptionCount; e += 1) {
      exceptions.push({
        from: reader.u30(),
        to: reader.u30(),
        target: reader.u30(),
        excType: reader.u30(),
        varName: reader.u30(),
      });
    }
    const traits = parseTraits(reader, resolve, `methodBody[${method}]`);

    if (method >= 0 && method < methods.length) {
      methods[method].body = {
        maxStack,
        localCount,
        initScopeDepth,
        maxScopeDepth,
        codeLength,
        codeSha256,
        codePreviewHex: codeHex.slice(0, 64),
        ...(includeCodeHex ? { codeHex } : {}),
        exceptionCount,
        exceptions: exceptions.map((ex) => ({
          ...ex,
          excTypeName: resolve.multinameText(ex.excType),
          varNameText: resolve.multinameText(ex.varName),
        })),
        traits,
      };
    }
  }

  const trailingBytes = buffer.length - reader.pos;

  return {
    header: {
      minorVersion,
      majorVersion,
      totalBytes: buffer.length,
      bytesConsumed: reader.pos,
      trailingBytes,
    },
    constantPool: {
      intCount: cp.ints.length - 1,
      uintCount: cp.uints.length - 1,
      doubleCount: cp.doubles.length - 1,
      stringCount: cp.strings.length - 1,
      namespaceCount: cp.namespaces.length - 1,
      nsSetCount: cp.nsSets.length - 1,
      multinameCount: cp.multinames.length - 1,
    },
    strings: cp.strings,
    methods,
    metadata,
    instances,
    classes,
    scripts,
  };
}

function attachMethodRefs(abc) {
  function addRef(methodIndex, ref) {
    if (methodIndex < 0 || methodIndex >= abc.methods.length) return;
    abc.methods[methodIndex].refs.push(ref);
  }

  for (const inst of abc.instances) {
    addRef(inst.iinit, {
      source: "instance_iinit",
      ownerIndex: inst.index,
      ownerName: inst.name,
      traitName: "__iinit__",
      traitKind: "initializer",
      static: false,
    });
    for (const tr of inst.traits) {
      if (tr.kind === 1 || tr.kind === 2 || tr.kind === 3) {
        addRef(tr.data.method, {
          source: "instance_trait",
          ownerIndex: inst.index,
          ownerName: inst.name,
          traitName: tr.name,
          traitKind: tr.kindName,
          static: false,
        });
      }
      if (tr.kind === 5) {
        addRef(tr.data.function, {
          source: "instance_trait_function",
          ownerIndex: inst.index,
          ownerName: inst.name,
          traitName: tr.name,
          traitKind: tr.kindName,
          static: false,
        });
      }
    }
  }

  for (const cls of abc.classes) {
    const inst = abc.instances[cls.index];
    const ownerName = inst ? inst.name : `class#${cls.index}`;
    addRef(cls.cinit, {
      source: "class_cinit",
      ownerIndex: cls.index,
      ownerName,
      traitName: "__cinit__",
      traitKind: "initializer",
      static: true,
    });
    for (const tr of cls.traits) {
      if (tr.kind === 1 || tr.kind === 2 || tr.kind === 3) {
        addRef(tr.data.method, {
          source: "class_trait",
          ownerIndex: cls.index,
          ownerName,
          traitName: tr.name,
          traitKind: tr.kindName,
          static: true,
        });
      }
      if (tr.kind === 5) {
        addRef(tr.data.function, {
          source: "class_trait_function",
          ownerIndex: cls.index,
          ownerName,
          traitName: tr.name,
          traitKind: tr.kindName,
          static: true,
        });
      }
    }
  }

  for (const scr of abc.scripts) {
    addRef(scr.init, {
      source: "script_init",
      ownerIndex: scr.index,
      ownerName: `script#${scr.index}`,
      traitName: "__script_init__",
      traitKind: "initializer",
      static: true,
    });
    for (const tr of scr.traits) {
      if (tr.kind === 1 || tr.kind === 2 || tr.kind === 3) {
        addRef(tr.data.method, {
          source: "script_trait",
          ownerIndex: scr.index,
          ownerName: `script#${scr.index}`,
          traitName: tr.name,
          traitKind: tr.kindName,
          static: true,
        });
      }
      if (tr.kind === 5) {
        addRef(tr.data.function, {
          source: "script_trait_function",
          ownerIndex: scr.index,
          ownerName: `script#${scr.index}`,
          traitName: tr.name,
          traitKind: tr.kindName,
          static: true,
        });
      }
    }
  }
}

function buildClassMethodMap(abc) {
  const classes = [];
  for (const inst of abc.instances) {
    const cls = abc.classes[inst.index];
    const entry = {
      classIndex: inst.index,
      className: inst.name,
      classNameNormalized: normalizeQualifiedName(inst.name),
      superName: inst.superName,
      superNameNormalized: normalizeQualifiedName(inst.superName),
      domainBucket: likelyDomainBucket(inst.name),
      flags: inst.flagsDecoded,
      interfaces: inst.interfaces,
      iinitMethod: inst.iinit,
      cinitMethod: cls ? cls.cinit : null,
      instanceMembers: [],
      staticMembers: [],
    };

    for (const tr of inst.traits) {
      if (tr.kind === 1 || tr.kind === 2 || tr.kind === 3 || tr.kind === 5) {
        const methodIndex = tr.kind === 5 ? tr.data.function : tr.data.method;
        const method = abc.methods[methodIndex];
        entry.instanceMembers.push({
          traitName: tr.name,
          traitKind: tr.kindName,
          methodIndex,
          methodName: method ? method.name : "",
          paramTypes: method ? method.paramTypes : [],
          returnType: method ? method.returnType : "",
          hasBody: Boolean(method && method.body),
          codeLength: method && method.body ? method.body.codeLength : 0,
        });
      }
    }
    entry.instanceMembers.sort(
      (a, b) =>
        a.traitName.localeCompare(b.traitName) || a.traitKind.localeCompare(b.traitKind)
    );

    if (cls) {
      for (const tr of cls.traits) {
        if (tr.kind === 1 || tr.kind === 2 || tr.kind === 3 || tr.kind === 5) {
          const methodIndex = tr.kind === 5 ? tr.data.function : tr.data.method;
          const method = abc.methods[methodIndex];
          entry.staticMembers.push({
            traitName: tr.name,
            traitKind: tr.kindName,
            methodIndex,
            methodName: method ? method.name : "",
            paramTypes: method ? method.paramTypes : [],
            returnType: method ? method.returnType : "",
            hasBody: Boolean(method && method.body),
            codeLength: method && method.body ? method.body.codeLength : 0,
          });
        }
      }
      entry.staticMembers.sort(
        (a, b) =>
          a.traitName.localeCompare(b.traitName) || a.traitKind.localeCompare(b.traitKind)
      );
    }

    classes.push(entry);
  }
  classes.sort((a, b) => a.className.localeCompare(b.className));
  return classes;
}

function buildMethodIndex(abc) {
  const methods = abc.methods.map((m) => ({
    index: m.index,
    name: m.name,
    paramCount: m.paramCount,
    paramTypes: m.paramTypes,
    returnType: m.returnType,
    hasBody: Boolean(m.body),
    codeLength: m.body ? m.body.codeLength : 0,
    maxStack: m.body ? m.body.maxStack : 0,
    localCount: m.body ? m.body.localCount : 0,
    exceptionCount: m.body ? m.body.exceptionCount : 0,
    refs: [...m.refs].sort(
      (a, b) =>
        a.ownerName.localeCompare(b.ownerName) ||
        a.traitName.localeCompare(b.traitName) ||
        a.traitKind.localeCompare(b.traitKind)
    ),
  }));
  methods.sort((a, b) => a.index - b.index);
  return methods;
}

function topNamespaces(classes, limit = 30) {
  const counts = new Map();
  for (const cls of classes) {
    const name = cls.classNameNormalized || cls.className;
    const parts = name.split(".");
    let key = name;
    if (parts.length >= 3) key = parts.slice(0, 3).join(".");
    else if (parts.length >= 2) key = parts.slice(0, 2).join(".");
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  return [...counts.entries()]
    .map(([namespace, count]) => ({ namespace, count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, limit);
}

function markdownReport(summary) {
  const lines = [];
  lines.push("# AVM2 Class/Method Map (frame2.abc)");
  lines.push("");
  lines.push(`- ABC file: \`${summary.abcPath}\``);
  lines.push(`- ABC bytes: ${summary.header.totalBytes}`);
  lines.push(`- Version: ${summary.header.majorVersion}.${summary.header.minorVersion}`);
  lines.push(`- Parsed bytes: ${summary.header.bytesConsumed}`);
  lines.push(`- Trailing bytes: ${summary.header.trailingBytes}`);
  lines.push("");
  lines.push("## Counts");
  lines.push(`- Methods: ${summary.counts.methodCount}`);
  lines.push(`- Methods with body: ${summary.counts.methodWithBodyCount}`);
  lines.push(`- Instances/classes: ${summary.counts.classCount}`);
  lines.push(`- Scripts: ${summary.counts.scriptCount}`);
  lines.push(`- Metadata entries: ${summary.counts.metadataCount}`);
  lines.push("");
  lines.push("## Top Namespaces");
  for (const n of summary.topNamespaces) {
    lines.push(`- ${n.namespace}: ${n.count}`);
  }
  lines.push("");
  lines.push("## Domain Buckets");
  for (const b of summary.domainBuckets) {
    lines.push(`- ${b.bucket}: ${b.count}`);
  }
  lines.push("");
  lines.push("## Largest Method Bodies");
  for (const m of summary.largestMethodBodies) {
    lines.push(
      `- #${m.index} ${m.displayName} -> ${m.codeLength} bytes (${m.refCount} refs)`
    );
  }
  lines.push("");
  lines.push("## High-Value Class Samples");
  for (const c of summary.sampleClasses) {
    lines.push(
      `- ${c.className}: ${c.instanceMethodCount} instance members, ${c.staticMethodCount} static members`
    );
  }
  lines.push("");
  return `${lines.join("\n")}\n`;
}

function codeHexToLines(codeHex, bytesPerLine = 16) {
  const lines = [];
  const stride = bytesPerLine * 2;
  for (let i = 0; i < codeHex.length; i += stride) {
    const chunkHex = codeHex.slice(i, i + stride);
    const groups = chunkHex.match(/.{1,2}/g) ?? [];
    const offset = (i / 2).toString(16).padStart(6, "0");
    lines.push(`${offset}: ${groups.join(" ")}`);
  }
  return lines;
}

function emitBytecodeLinesJsonl(reportsDir, methods, outPrefix = "") {
  const rows = [];
  for (const method of methods) {
    if (!method.body || !method.body.codeHex) continue;
    rows.push(
      JSON.stringify({
        methodIndex: method.index,
        methodName: method.name,
        displayName: method.name || method.refs[0]?.traitName || `method_${method.index}`,
        codeLength: method.body.codeLength,
        codeSha256: method.body.codeSha256,
        refs: method.refs,
        bytecodeLines: codeHexToLines(method.body.codeHex),
      })
    );
  }
  const fileName = `${outPrefix}avm2_method_bytecode_lines.jsonl`;
  return {
    fileName,
    writeStatus: stableWrite(path.join(reportsDir, fileName), `${rows.join("\n")}\n`),
  };
}

function main() {
  const args = parseArgs(process.argv);
  if (args.help) {
    console.log(usage());
    return;
  }

  const root = path.resolve(args.root);
  const abcPath = args.abc ? path.resolve(args.abc) : path.join(root, DEFAULT_ABC_REL);
  if (!fs.existsSync(abcPath)) {
    throw new Error(`ABC file not found: ${abcPath}`);
  }

  const reportsDir = path.join(root, "reports");
  ensureDir(reportsDir);

  const buffer = fs.readFileSync(abcPath);
  const abc = parseAbc(buffer, { includeCodeHex: args.emitBytecodeLines });
  attachMethodRefs(abc);

  const classes = buildClassMethodMap(abc);
  const methods = buildMethodIndex(abc);

  const domainCount = new Map();
  for (const c of classes) {
    domainCount.set(c.domainBucket, (domainCount.get(c.domainBucket) || 0) + 1);
  }
  const domainBuckets = [...domainCount.entries()]
    .map(([bucket, count]) => ({ bucket, count }))
    .sort((a, b) => b.count - a.count);

  const largestMethodBodies = methods
    .filter((m) => m.hasBody)
    .sort((a, b) => b.codeLength - a.codeLength)
    .slice(0, 40)
    .map((m) => ({
      index: m.index,
      name: m.name,
      displayName: m.name || m.refs[0]?.traitName || `method_${m.index}`,
      codeLength: m.codeLength,
      refCount: m.refs.length,
    }));

  const classSnapshots = classes
    .map((c) => ({
      className: c.className,
      domainBucket: c.domainBucket,
      instanceMethodCount: c.instanceMembers.length,
      staticMethodCount: c.staticMembers.length,
    }))
    .sort(
      (a, b) =>
        b.instanceMethodCount + b.staticMethodCount - (a.instanceMethodCount + a.staticMethodCount)
    )
    .slice(0, 80);

  const outPrefix = args.outPrefix || "";
  const summary = {
    abcPath,
    header: abc.header,
    constantPool: abc.constantPool,
    counts: {
      methodCount: methods.length,
      methodWithBodyCount: methods.filter((m) => m.hasBody).length,
      classCount: classes.length,
      scriptCount: abc.scripts.length,
      metadataCount: abc.metadata.length,
    },
    topNamespaces: topNamespaces(classes, 40),
    domainBuckets,
    largestMethodBodies,
    sampleClasses: classSnapshots.slice(0, 25),
    outputs: {
      classMethodMap: `reports/${outPrefix}avm2_class_method_map.json`,
      methodIndex: `reports/${outPrefix}avm2_method_index.json`,
      summary: `reports/${outPrefix}avm2_summary.json`,
      markdown: `reports/${outPrefix}avm2_summary.md`,
      ...(args.emitBytecodeLines
        ? { bytecodeLines: `reports/${outPrefix}avm2_method_bytecode_lines.jsonl` }
        : {}),
    },
  };

  const classMapDoc = {
    abcPath,
    generatedBy: "analyze-avm2-abc.mjs",
    classes,
  };
  const methodIndexDoc = {
    abcPath,
    generatedBy: "analyze-avm2-abc.mjs",
    methods,
  };

  const writes = {
    classMethodMap: stableWrite(
      path.join(reportsDir, `${outPrefix}avm2_class_method_map.json`),
      `${JSON.stringify(classMapDoc, null, 2)}\n`
    ),
    methodIndex: stableWrite(
      path.join(reportsDir, `${outPrefix}avm2_method_index.json`),
      `${JSON.stringify(methodIndexDoc, null, 2)}\n`
    ),
    summary: stableWrite(
      path.join(reportsDir, `${outPrefix}avm2_summary.json`),
      `${JSON.stringify(summary, null, 2)}\n`
    ),
    markdown: stableWrite(
      path.join(reportsDir, `${outPrefix}avm2_summary.md`),
      markdownReport(summary)
    ),
  };
  if (args.emitBytecodeLines) {
    const bytecodeWrite = emitBytecodeLinesJsonl(reportsDir, abc.methods, outPrefix);
    writes.bytecodeLines = bytecodeWrite.writeStatus;
  }

  console.log(
    JSON.stringify(
      {
        abcPath,
        writes,
        counts: summary.counts,
        topNamespaces: summary.topNamespaces.slice(0, 12),
        domainBuckets: summary.domainBuckets,
      },
      null,
      2
    )
  );
}

try {
  main();
} catch (err) {
  console.error(`[analyze-avm2-abc] ${err && err.message ? err.message : err}`);
  process.exitCode = 1;
}
