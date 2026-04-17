// Shared Web Serial OBDLink/ELM327 engine for FCA UDS work.
// Returns { connect, disconnect, uds, isConnected, isSTN }.
// Caller passes a log(msg, type) callback. UDS responses are returned
// as { ok, d:Uint8Array, raw, err } with multi-frame ISO-TP already
// reassembled by the adapter (ATCAF1 + ATFC*) and the hex tokens
// concatenated into a single byte array. Negative UDS responses
// (0x7F SID NRC) are treated as failures, NOT successes.

const hx = (n, w = 2) => n.toString(16).toUpperCase().padStart(w, "0");

const NRC_NAMES = {
  0x10: "general reject", 0x11: "service not supported",
  0x12: "subfunction not supported", 0x13: "bad message length",
  0x21: "busy repeat request", 0x22: "conditions not correct",
  0x24: "request sequence error", 0x31: "request out of range",
  0x33: "security access denied", 0x35: "invalid key",
  0x36: "exceeded number of attempts", 0x37: "required time delay not expired",
  0x70: "upload/download not accepted", 0x72: "general programming failure",
  0x78: "response pending", 0x7E: "subfunction not supported in active session",
  0x7F: "service not supported in active session",
};

export function createObdEngine(log = () => {}) {
  let port = null;
  let writer = null;
  let reader = null;
  let connected = false;
  let isSTN = false;
  let curTx = -1, curRx = -1;
  let rxBuf = "";
  let pumpRunning = false;
  let pumpDone = null;
  const tdec = new TextDecoder();
  const tenc = new TextEncoder();

  // Continuous read-pump: keeps reader.read() in flight at all times so
  // we never leave a pending read across rawSend() timeouts. Data lands
  // in rxBuf; rawSend() polls rxBuf for the prompt character.
  async function pump() {
    pumpRunning = true;
    try {
      while (pumpRunning && reader) {
        const res = await reader.read();
        if (res.done) break;
        if (res.value) rxBuf += tdec.decode(res.value);
      }
    } catch {
      // canceled or stream closed; exit cleanly
    } finally {
      pumpRunning = false;
      if (pumpDone) { const d = pumpDone; pumpDone = null; d(); }
    }
  }

  async function rawSend(cmd, timeoutMs = 3000) {
    if (!writer) return "";
    rxBuf = "";
    try { await writer.write(tenc.encode(cmd + "\r")); } catch { return ""; }
    log("TX > " + cmd, "tx");
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const pi = rxBuf.indexOf(">");
      if (pi !== -1) {
        const r = rxBuf.substring(0, pi).replace(/\r/g, "\n").replace(/\n+/g, "\n").trim();
        rxBuf = rxBuf.substring(pi + 1);
        log("RX < " + r, "rx");
        return r;
      }
      await new Promise(r => setTimeout(r, 30));
    }
    const t = rxBuf.replace(/\r/g, "\n").replace(/\n+/g, "\n").replace(/>/g, "").trim();
    if (t) log("RX (timeout) < " + t, "warn");
    return t;
  }

  async function connect() {
    if (typeof navigator === "undefined" || !navigator.serial) {
      throw new Error("Web Serial not supported in this browser");
    }
    try {
      port = await navigator.serial.requestPort();
      await port.open({ baudRate: 115200 });
      writer = port.writable.getWriter();
      reader = port.readable.getReader();
      pump();   // start continuous read pump

      await rawSend("ATZ", 3000);
      await new Promise(r => setTimeout(r, 800));
      await rawSend("ATE0");
      const ati = await rawSend("ATI");
      const stdi = await rawSend("STDI");
      isSTN = stdi && !stdi.includes("?") && stdi.length > 2;
      log("Adapter: " + (isSTN ? "STN/OBDLink" : "ELM327") + " (" + ati + ")", "info");

      if (isSTN) {
        log("Setting MFG extended mode...", "info");
        await rawSend("ATPP2CSV81", 2000);
        await rawSend("ATPP2CON", 2000);
        await rawSend("ATPP2DSV01", 2000);
        await rawSend("ATPP2DON", 2000);
        await rawSend("ATZ", 3000);
        await new Promise(r => setTimeout(r, 1000));
        await rawSend("ATE0", 2000);
        await new Promise(r => setTimeout(r, 200));
      }
      await rawSend("ATL0");
      await rawSend("ATS1");
      await rawSend("ATH1");
      await rawSend("ATSP6");
      await rawSend("ATAT2");
      await rawSend("ATST96");
      await rawSend("ATCAF1");
      if (isSTN) {
        await rawSend("ATFCSH7E0");
        await rawSend("ATFCSD300000");
        await rawSend("ATFCSM1");
      }
      curTx = -1; curRx = -1;
      connected = true;
      log("Connected", "info");
    } catch (e) {
      // Cleanup any partially-acquired resources on failure.
      try { pumpRunning = false; if (reader) await reader.cancel(); } catch {}
      try { if (reader) reader.releaseLock(); } catch {}
      try { if (writer) writer.releaseLock(); } catch {}
      try { if (port) await port.close(); } catch {}
      reader = null; writer = null; port = null; connected = false;
      throw e;
    }
  }

  async function disconnect() {
    connected = false;
    pumpRunning = false;
    try {
      if (reader) {
        const waitPump = new Promise(res => { pumpDone = res; });
        try { await reader.cancel(); } catch {}
        await Promise.race([waitPump, new Promise(r => setTimeout(r, 500))]);
      }
    } catch {}
    try { if (reader) reader.releaseLock(); } catch {}
    try { if (writer) writer.releaseLock(); } catch {}
    try { if (port) await port.close(); } catch {}
    reader = null; writer = null; port = null;
    log("Disconnected", "info");
  }

  // Strip ELM327 newlines, line headers, and ISO-TP PCI bytes to get
  // the raw UDS payload. Returns Uint8Array of the assembled bytes.
  function parseUdsResponse(raw) {
    const lines = raw.split(/[\r\n]+/).map(l => l.trim()).filter(Boolean);
    const all = [];
    for (const line of lines) {
      if (/SEARCHING|^OK$/i.test(line)) continue;
      // Lines may look like "750 03 7E 03 49 02" (with header), or
      // "0:1014620100000102" (multi-frame with PCI), or just hex.
      const colonIdx = line.indexOf(":");
      const payload = colonIdx !== -1 ? line.substring(colonIdx + 1) : line;
      const toks = payload.split(/\s+/);
      // Drop a leading 3-hex CAN ID if present.
      if (toks.length > 1 && /^[0-9A-Fa-f]{3}$/.test(toks[0])) toks.shift();
      const bytes = [];
      for (const t of toks) {
        const stripped = t.replace(/[^0-9A-Fa-f]/g, "");
        for (let i = 0; i + 1 < stripped.length; i += 2) {
          bytes.push(parseInt(stripped.substring(i, i + 2), 16));
        }
      }
      if (!bytes.length) continue;
      // Strip ISO-TP PCI on multi-frame fragments: first frame begins
      // with 0x1L LL (2-byte PCI), consecutive frames begin with 0x2N
      // (1-byte PCI). Single frame has 1-byte PCI 0x0L.
      const pciHi = bytes[0] & 0xF0;
      if (pciHi === 0x10 && bytes.length > 2) bytes.splice(0, 2);          // FF
      else if (pciHi === 0x20) bytes.splice(0, 1);                          // CF
      else if (pciHi === 0x00 && bytes.length > 1) bytes.splice(0, 1);      // SF
      for (const b of bytes) all.push(b);
    }
    return new Uint8Array(all);
  }

  async function uds(tx, rx, data, timeoutMs = 4000) {
    if (!connected) return { ok: false, raw: "", err: "not connected" };
    if (tx !== curTx || rx !== curRx) {
      await rawSend("ATCRA");
      await rawSend("ATSH" + hx(tx, 3));
      if (isSTN) await rawSend("ATFCSH" + hx(tx, 3));
      await rawSend("ATCRA" + hx(rx, 3));
      curTx = tx; curRx = rx;
    }
    const expectedSid = (data[0] | 0x40) & 0xFF;
    const h = Array.from(data).map(b => hx(b)).join(" ");
    const r = await rawSend(h, timeoutMs);
    if (!r || /NO DATA|CAN ERROR|UNABLE|BUS|STOPPED/i.test(r)) {
      return { ok: false, raw: r || "", err: r || "no response" };
    }
    if (r.includes("?") || /ERROR/i.test(r)) {
      return { ok: false, raw: r, err: r };
    }
    const d = parseUdsResponse(r);
    if (!d.length) return { ok: false, raw: r, err: "no hex bytes" };
    // UDS negative response: 7F <requestSID> <NRC>.
    if (d[0] === 0x7F && d.length >= 3) {
      const nrc = d[2];
      // 0x78 = response pending — keep polling until terminal NRC or success.
      if (nrc === 0x78) {
        let attempts = 0;
        let lastRaw = r;
        while (attempts++ < 8) {
          const r2 = await rawSend("", timeoutMs);
          if (!r2) break;
          lastRaw = r2;
          const d2 = parseUdsResponse(r2);
          if (d2.length && d2[0] === expectedSid) return { ok: true, d: d2, raw: r2 };
          if (d2.length >= 3 && d2[0] === 0x7F && d2[2] !== 0x78) {
            return { ok: false, raw: r2, err: "NRC 0x" + hx(d2[2]) + " (" + (NRC_NAMES[d2[2]] || "unknown") + ")", nrc: d2[2] };
          }
        }
        return { ok: false, raw: lastRaw, err: "stalled waiting on response pending" };
      }
      return { ok: false, raw: r, err: "NRC 0x" + hx(nrc) + " (" + (NRC_NAMES[nrc] || "unknown") + ")", nrc };
    }
    // Validate positive response SID matches the request.
    if (d[0] !== expectedSid) {
      return { ok: false, raw: r, d, err: "unexpected SID 0x" + hx(d[0]) + " (expected 0x" + hx(expectedSid) + ")" };
    }
    return { ok: true, d, raw: r };
  }

  return {
    connect, disconnect, uds,
    get isConnected() { return connected; },
    get isSTN() { return isSTN; },
  };
}

// Decode FCA / SAE J2012 DTC bytes (3 bytes per code) into a string
// like "P0301" or "B1310". Status byte follows each code in 0x19/0x02
// responses but is not part of the code itself.
export function decodeDTC(b0, b1, b2) {
  const letter = ["P", "C", "B", "U"][(b0 >> 6) & 0x03];
  const d1 = (b0 >> 4) & 0x03;
  const d2 = b0 & 0x0F;
  const d3 = (b1 >> 4) & 0x0F;
  const d4 = b1 & 0x0F;
  const d5 = (b2 >> 4) & 0x0F;
  const d6 = b2 & 0x0F;
  return letter + d1.toString() + d2.toString(16).toUpperCase() +
    d3.toString(16).toUpperCase() + d4.toString(16).toUpperCase() +
    d5.toString(16).toUpperCase() + d6.toString(16).toUpperCase();
}

export function decodeDTCStatus(s) {
  const labels = [];
  if (s & 0x01) labels.push("test failed");
  if (s & 0x02) labels.push("failed this cycle");
  if (s & 0x04) labels.push("pending");
  if (s & 0x08) labels.push("confirmed");
  if (s & 0x40) labels.push("unconfirmed");
  if (s & 0x80) labels.push("warning");
  return labels.join(", ") || "ok";
}
