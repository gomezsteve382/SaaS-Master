"""
uds_transport.py — UDS transport layer (decompiled from FCA_PROXI_Tool.exe)

Reconstructed from PyInstaller-extracted + decompiled .pyc for Python 3.12.
Original file: FCA_PROXI_Tool/_internal/proxi/uds_transport.cpython-312.pyc

Wraps a J2534 PassThru device (via pythonnet / win32com) to execute the
PROXI read/write UDS sequence documented in fca-proxi-reference.md §6.

DO NOT REDISTRIBUTE — internal bench reference only.
"""
from __future__ import annotations

import time
from typing import Callable, Optional, Tuple

UDS_SERVICES = {
    "DiagnosticSessionControl":  0x10,
    "ECUReset":                  0x11,
    "SecurityAccess":            0x27,
    "ReadDataByIdentifier":      0x22,
    "WriteDataByIdentifier":     0x2E,
    "TesterPresent":             0x3E,
    "NegativeResponse":          0x7F,
}

SESSION_EXTENDED = 0x03
RESET_HARD = 0x01

# Security level used for BCM PROXI operations
BCM_SECURITY_LEVEL = 1  # RequestSeed byte = 0x01, SendKey byte = 0x02

PROXI_DID_PRE_SGW = 0xFD01
PROXI_DID_SGW = 0xFD20

NRC_DESCRIPTIONS = {
    0x10: "generalReject",
    0x11: "serviceNotSupported",
    0x12: "subFunctionNotSupported",
    0x13: "incorrectMessageLengthOrInvalidFormat",
    0x22: "conditionsNotCorrect",
    0x24: "requestSequenceError",
    0x31: "requestOutOfRange",
    0x33: "securityAccessDenied",
    0x35: "invalidKey",
    0x36: "exceededNumberOfAttempts",
    0x37: "requiredTimeDelayNotExpired",
    0x70: "uploadDownloadNotAccepted",
    0x72: "generalProgrammingFailure",
    0x78: "requestCorrectlyReceivedResponsePending",
    0x7E: "subFunctionNotSupportedInActiveSession",
    0x7F: "serviceNotSupportedInActiveSession",
}


class UdsError(Exception):
    def __init__(self, service: int, nrc: int):
        self.service = service
        self.nrc = nrc
        super().__init__(
            f"NRC 0x{nrc:02X} ({NRC_DESCRIPTIONS.get(nrc, 'unknown')}) "
            f"for service 0x{service:02X}"
        )


class UdsTransport:
    """
    Thin UDS transport wrapper used by FCA PROXI Tool.

    The real implementation uses pythonnet to call the J2534 PassThru DLL
    via a .NET wrapper (CanTool.J2534Wrapper). This reconstruction uses
    a generic send/receive callback so it can be exercised without a real
    device.
    """

    def __init__(
        self,
        send: Callable[[bytes], None],
        receive: Callable[[int], bytes],
        tx_id: int = 0x7E0,
        rx_id: int = 0x7E8,
        timeout_ms: int = 1000,
    ):
        self._send = send
        self._receive = receive
        self.tx_id = tx_id
        self.rx_id = rx_id
        self.timeout_ms = timeout_ms

    def _uds(self, request: bytes) -> bytes:
        """Send a UDS request and return the positive response payload."""
        self._send(request)
        raw = self._receive(self.timeout_ms)
        if not raw:
            raise TimeoutError("No response")
        if raw[0] == 0x7F:
            raise UdsError(service=raw[1] if len(raw) > 1 else 0, nrc=raw[2] if len(raw) > 2 else 0)
        return raw

    # -----------------------------------------------------------------------
    # PROXI read / write sequence
    # -----------------------------------------------------------------------

    def enter_extended_session(self) -> None:
        resp = self._uds(bytes([0x10, SESSION_EXTENDED]))
        assert resp[0] == 0x50, f"Unexpected response 0x{resp[0]:02X}"

    def tester_present(self) -> None:
        self._uds(bytes([0x3E, 0x00]))

    def request_seed(self, level: int = BCM_SECURITY_LEVEL) -> bytes:
        resp = self._uds(bytes([0x27, (level * 2) - 1]))
        assert resp[0] == 0x67
        return resp[2:]  # seed bytes

    def send_key(self, level: int, key: bytes) -> None:
        resp = self._uds(bytes([0x27, level * 2]) + key)
        assert resp[0] == 0x67

    def read_proxi(self, sgw: bool = False) -> bytes:
        did = PROXI_DID_SGW if sgw else PROXI_DID_PRE_SGW
        resp = self._uds(bytes([0x22, (did >> 8) & 0xFF, did & 0xFF]))
        assert resp[0] == 0x62
        return resp[3:]  # strip 0x62 + DID word

    def write_proxi(self, data: bytes, sgw: bool = False) -> None:
        did = PROXI_DID_SGW if sgw else PROXI_DID_PRE_SGW
        request = bytes([0x2E, (did >> 8) & 0xFF, did & 0xFF]) + data
        resp = self._uds(request)
        assert resp[0] == 0x6E

    def ecu_reset(self) -> None:
        self._uds(bytes([0x11, RESET_HARD]))

    def full_read_proxi_sequence(
        self,
        key_algorithm: Callable[[bytes], bytes],
        sgw: bool = False,
    ) -> bytes:
        """
        Execute the full PROXI read sequence:
        1. Enter extended diagnostic session
        2. Tester present
        3. Request seed
        4. Compute key via key_algorithm(seed) → send key
        5. Read PROXI DID
        Returns raw PROXI bytes.
        """
        self.enter_extended_session()
        self.tester_present()
        seed = self.request_seed()
        key = key_algorithm(seed)
        self.send_key(BCM_SECURITY_LEVEL, key)
        return self.read_proxi(sgw=sgw)

    def full_write_proxi_sequence(
        self,
        proxi_data: bytes,
        key_algorithm: Callable[[bytes], bytes],
        sgw: bool = False,
    ) -> None:
        """
        Execute the full PROXI write sequence, ending with ECU hard reset.
        """
        self.enter_extended_session()
        self.tester_present()
        seed = self.request_seed()
        key = key_algorithm(seed)
        self.send_key(BCM_SECURITY_LEVEL, key)
        self.write_proxi(proxi_data, sgw=sgw)
        self.ecu_reset()
