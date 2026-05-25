---
name: UDS Session Analyzer
description: Architecture and key decisions for the udsanalyzer tab added in Task #719
---

# UDS Session Analyzer

Tab id: `udsanalyzer`. Registered between `binintel` and `sigdisc` in WORKSPACE_TABS.

## Key files
- `artifacts/srt-lab/src/lib/udsSessionAnalyzer/parser.js` — parseTrace()
- `artifacts/srt-lab/src/lib/udsSessionAnalyzer/analyze.js` — analyzeSession()
- `artifacts/srt-lab/src/lib/udsSessionAnalyzer/fixtures/example_session.log`
- `artifacts/srt-lab/src/lib/__tests__/udsSessionAnalyzer.test.js`
- `artifacts/srt-lab/src/tabs/UdsAnalyzerTab.jsx`

## Design decisions

**ISO-TP PCI stripping**: applied only to candump and TX/RX shapes (raw CAN frames). Req/Resp and bare-hex shapes are treated as already-assembled UDS payloads — no stripping.

**Why:** The [Req]/[Resp] tool format outputs assembled UDS bytes without ISO-TP framing. Stripping there would corrupt valid SIDs (e.g. 0x22 misidentified as SF PCI len=2).

**Direction inference for bare hex**: 0x7F → resp; first byte ≥0x50 AND serviceForPosRsp() returns non-null → resp; else → req.

**0x78 handling**: pending frames collected into pendingNrcs list. If final response follows → normal exchange with note. If no final response → type=pending_timeout, severity=FAIL.

**TesterPresent with suppress bit (0x3E 0x8x)**: type=suppress, severity=OK, no response needed.

**@workspace/uds**: already a devDependency of @workspace/srt-lab. Import serviceForSid, serviceForPosRsp, NRC_TABLE directly. NRC_TABLE entries have .code, .shortName, .description, .isPending.
