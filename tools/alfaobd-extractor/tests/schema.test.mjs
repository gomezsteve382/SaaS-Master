/**
 * Schema-validation test for the AlfaOBD extraction output.
 *
 * Strategy:
 *   - When the SRT Lab `public/alfaobd-tables/` directory exists and
 *     contains a `manifest.json`, every JSON file under that tree is
 *     validated against the schema in `src/schema.mjs`.
 *   - When the directory is empty (fresh checkout, no AlfaOBD.exe
 *     supplied), we skip cleanly. The pipeline itself refuses to run
 *     without the binary, so the absence of output is the expected
 *     state on most machines.
 *
 * Plus: an inline round-trip test feeds a synthetic decompiled C# tree
 * through `parseDecompiled.parseDecompiled()` and validates the
 * resulting payloads against the schema. This catches parser
 * regressions even when no real extraction has been run.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { OUTPUT_LAYOUT, SCHEMA_VERSION, validate } from "../src/schema.mjs";
import { parseDecompiled } from "../src/parseDecompiled.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, "../../..");
const EXTRACT_DIR = join(REPO_ROOT, "artifacts/srt-lab/public/alfaobd-tables");

test("synthetic decompiled tree → schemas hold", () => {
  const filesByPath = new Map();
  filesByPath.set(
    "AlfaOBD/Diag/EcuTypes.cs",
    `
namespace AlfaOBD.Diag {
  public enum ECUTYPE_KWP2000 : int {
    NoModule    = 0x000,
    Engine_NGC4 = 0x132,
    Trans_NAG2  = 0x1A6,
  }
  public enum ECUTYPE_BCAN : int {
    BCM = 0x0CC,
    RFH = 0x1ED,
  }
}
`);
  filesByPath.set(
    "AlfaOBD/Diag/EcuRouting.cs",
    `
namespace AlfaOBD.Diag {
  public static class EcuRouting {
    public static void Resolve() {
      switch (e) {
        case ECUTYPE_KWP2000.Engine_NGC4: tx = 0x7E0; rx = 0x7E8; break;
      }
    }
  }
}
`);
  filesByPath.set(
    "AlfaOBD/Process/Handlers.cs",
    `
namespace AlfaOBD.Process {
  public class HandlerHost {
    public void ProcessECUData(byte[] resp) {
      var t = SendActiveDiagnostic2();
      ReadObd(0x22, 0xF1, 0x90);
      CheckResult(t, 0x7F);
    }
    public void ProcessEDC17_FRMNTData() {
      RequestDownload();
      TransferData();
      var x = ReceiveResult(0x36);
    }
  }
}
`);
  filesByPath.set(
    "AlfaOBD/Transport/J2534Channel.cs",
    `
using SAE.J2534;
using J2534Sharp;
namespace AlfaOBD.Transport {
  public class J2534Channel {
    public void Open() { var c = new J2534Sharp.PassThru(); }
  }
}
`);
  filesByPath.set(
    "AlfaOBD/Transport/SerialChannel.cs",
    `
using System.IO.Ports;
using Stn.Ftdi;
namespace AlfaOBD.Transport {
  public class SerialChannel {
    SerialPort port;
    FtdiStream ftdi;
  }
}
`);
  filesByPath.set(
    "AlfaOBD/Transport/BluetoothChannel.cs",
    `
using InTheHand.Net.Sockets;
namespace AlfaOBD.Transport {
  public class BluetoothChannel {
    BluetoothClient client;
    BluetoothDeviceInfo info;
    BluetoothSecurity sec;
  }
}
`);

  const { ecutypeFamilies, handlers, transports } = parseDecompiled(filesByPath);

  // Two ECUTYPE families discovered.
  const famNames = ecutypeFamilies.map(f => f.family).sort();
  assert.deepEqual(famNames, ["ECUTYPE_BCAN", "ECUTYPE_KWP2000"]);

  // KWP2000 has 3 modules with TX/RX address learned for Engine_NGC4.
  const kwp = ecutypeFamilies.find(f => f.family === "ECUTYPE_KWP2000");
  assert.equal(kwp.modules.length, 3);
  const eng = kwp.modules.find(m => m.name === "Engine_NGC4");
  assert.equal(eng.ecu_type_id, "0x132");
  assert.equal(eng.tx_address, "0x7E0");
  assert.equal(eng.rx_address, "0x7E8");

  // Handlers: 2 expected, with their calls captured.
  const handlerNames = handlers.map(h => h.name).sort();
  assert.deepEqual(handlerNames, ["ProcessECUData", "ProcessEDC17_FRMNTData"]);
  const procEcu = handlers.find(h => h.name === "ProcessECUData");
  assert.ok(procEcu.calls.includes("SendActiveDiagnostic2"));
  assert.ok(procEcu.calls.includes("ReadObd"));
  assert.ok(procEcu.uds_services.includes("0x22"));

  // Transports: serial + bluetooth + j2534 buckets.
  const kinds = transports.map(t => t.kind).sort();
  assert.ok(kinds.includes("serial"));
  assert.ok(kinds.includes("bluetooth"));
  assert.ok(kinds.includes("j2534"));

  // Validate every emitted shape against the schema.
  for (const fam of ecutypeFamilies) {
    const errors = validate("ecutypeFamily", {
      schema_version: SCHEMA_VERSION, family: fam.family, modules: fam.modules,
    });
    assert.deepEqual(errors, [], `ecutypeFamily errors for ${fam.family}`);
  }
  assert.deepEqual(
    validate("handlers", { schema_version: SCHEMA_VERSION, handlers }),
    []);
  assert.deepEqual(
    validate("transports", { schema_version: SCHEMA_VERSION, transports }),
    []);
});

test("schema rejects malformed manifest", () => {
  const bad = { schema_version: 999, tool: {}, generated_at: 0 };
  const errors = validate("manifest", bad);
  assert.ok(errors.length >= 3, `expected multiple errors, got ${errors.length}`);
  assert.ok(errors.some(e => e.includes("schema_version")));
});

test("schema accepts a complete minimal manifest", () => {
  const ok = {
    schema_version: SCHEMA_VERSION,
    tool: {
      name: "@workspace/alfaobd-extractor",
      version: "0.1.0",
      decompiler: { name: "ilspycmd", version_command: "ilspycmd --version" },
    },
    generated_at: new Date().toISOString(),
    alfaobd: {
      sha256: "0".repeat(64),
      size_bytes: 1,
      file_version: "2.5.7.0",
      is_dotnet: true,
      clr_version: "v4.0.30319",
    },
    shfolder: {
      sha256: "0".repeat(64),
      size_bytes: 1,
      protected_skip: true,
      protector: "Safengine Shielden v2.3.9.0",
      exports: [], imports: [],
    },
    inputs: { alfaobd_path: "x", shfolder_path: "y" },
    outputs: { files: [] },
  };
  assert.deepEqual(validate("manifest", ok), []);
});

test("real extracted output (when present) matches schema", (t) => {
  if (!existsSync(EXTRACT_DIR) || !existsSync(join(EXTRACT_DIR, OUTPUT_LAYOUT.manifest))) {
    t.skip("no extracted alfaobd-tables/manifest.json — run tools/alfaobd-extractor/extract.mjs to populate");
    return;
  }
  const manifest = JSON.parse(readFileSync(join(EXTRACT_DIR, OUTPUT_LAYOUT.manifest), "utf8"));
  assert.deepEqual(validate("manifest", manifest), []);

  const handlersPath = join(EXTRACT_DIR, OUTPUT_LAYOUT.handlers);
  if (existsSync(handlersPath)) {
    assert.deepEqual(
      validate("handlers", JSON.parse(readFileSync(handlersPath, "utf8"))), []);
  }
  const transportsPath = join(EXTRACT_DIR, OUTPUT_LAYOUT.transports);
  if (existsSync(transportsPath)) {
    assert.deepEqual(
      validate("transports", JSON.parse(readFileSync(transportsPath, "utf8"))), []);
  }
  const resourcesPath = join(EXTRACT_DIR, OUTPUT_LAYOUT.resources);
  if (existsSync(resourcesPath)) {
    assert.deepEqual(
      validate("resources", JSON.parse(readFileSync(resourcesPath, "utf8"))), []);
  }

  const ecuDir = join(EXTRACT_DIR, OUTPUT_LAYOUT.ecutypesDir);
  if (existsSync(ecuDir) && statSync(ecuDir).isDirectory()) {
    for (const name of readdirSync(ecuDir)) {
      if (!name.endsWith(".json")) continue;
      const payload = JSON.parse(readFileSync(join(ecuDir, name), "utf8"));
      assert.deepEqual(validate("ecutypeFamily", payload), [], `family ${name} schema`);
    }
  }
});
