#!/usr/bin/env python3
"""
SRT Lab J2534 Bridge Daemon
============================

Exposes the Autel MaxiFlash VCI (or any J2534-compliant adapter) as a localhost
HTTP API that the SRT Lab React app can talk to.

Why this exists:
    J2534 is a Windows DLL-based API. Browsers can't load DLLs directly. This
    bridge runs as a small local daemon, loads the vendor's J2534 DLL via
    ctypes, and provides HTTP endpoints the web app uses.

Supported adapters:
    - Autel MaxiFlash VCI    -> MaxiFlashJ2534.dll
    - Autel MaxiFlash Elite  -> MaxiFlashJ2534.dll
    - Autel IM608/IM608 Pro  -> MaxiFlashJ2534.dll (shared driver)
    - Other J2534-2 devices  -> their vendor DLL

The MaxiFlash handles SGW (Secure Gateway) authentication in firmware using
Autel's licensed credentials. This bridge does not perform any SGW bypass on
its own; it just relays standard J2534 calls to the vendor DLL, which relays
them to the VCI hardware, which does the authenticated handshake.

Usage:
    python3 j2534_bridge.py --dll "C:\\Program Files\\Autel\\MaxiFlashJ2534.dll"
    python3 j2534_bridge.py --dll /path/to/lib.dylib --port 8765 --verbose

Endpoints:
    GET  /status           -> bridge/VCI status JSON
    POST /open             -> PassThruOpen
    POST /connect          -> PassThruConnect (body: {protocol, flags, baudrate})
    POST /disconnect       -> PassThruDisconnect
    POST /close            -> PassThruClose
    POST /sendmsg          -> PassThruWriteMsgs (body: {tx_id, data, flags})
    POST /readmsg          -> PassThruReadMsgs  (body: {timeout_ms})
    POST /setfilter        -> PassThruStartMsgFilter (body: {tx_id, rx_id})

Responses are JSON. Binary data is hex-encoded.
"""

import argparse
import ctypes
import json
import os
import platform
import socket
import sys
import threading
from http.server import BaseHTTPRequestHandler, HTTPServer
from urllib.parse import urlparse


# ---------------------------------------------------------------------------
# J2534 PassThru constants (from SAE J2534-2)
# ---------------------------------------------------------------------------

PROTOCOL_J1850VPW       = 0x01
PROTOCOL_J1850PWM       = 0x02
PROTOCOL_ISO9141        = 0x03
PROTOCOL_ISO14230       = 0x04
PROTOCOL_CAN            = 0x05
PROTOCOL_ISO15765       = 0x06

PASS_FILTER     = 0x01
BLOCK_FILTER    = 0x02
FLOW_CONTROL    = 0x03

ISO15765_FRAME_PAD  = 0x00000040
CAN_29BIT_ID        = 0x00000100
ISO15765_ADDR_TYPE  = 0x00000080

ERRORS = {
    0x00: 'STATUS_NOERROR',
    0x01: 'ERR_NOT_SUPPORTED',
    0x02: 'ERR_INVALID_CHANNEL_ID',
    0x03: 'ERR_INVALID_PROTOCOL_ID',
    0x04: 'ERR_NULL_PARAMETER',
    0x05: 'ERR_INVALID_IOCTL_VALUE',
    0x06: 'ERR_INVALID_FLAGS',
    0x07: 'ERR_FAILED',
    0x08: 'ERR_DEVICE_NOT_CONNECTED',
    0x09: 'ERR_TIMEOUT',
    0x0A: 'ERR_INVALID_MSG',
    0x0B: 'ERR_INVALID_TIME_INTERVAL',
    0x0C: 'ERR_EXCEEDED_LIMIT',
    0x0D: 'ERR_INVALID_MSG_ID',
    0x0E: 'ERR_DEVICE_IN_USE',
    0x0F: 'ERR_INVALID_IOCTL_ID',
    0x10: 'ERR_BUFFER_EMPTY',
    0x11: 'ERR_BUFFER_FULL',
    0x12: 'ERR_BUFFER_OVERFLOW',
    0x13: 'ERR_PIN_INVALID',
    0x14: 'ERR_CHANNEL_IN_USE',
    0x15: 'ERR_MSG_PROTOCOL_ID',
    0x16: 'ERR_INVALID_FILTER_ID',
    0x17: 'ERR_NO_FLOW_CONTROL',
    0x18: 'ERR_NOT_UNIQUE',
    0x19: 'ERR_INVALID_BAUDRATE',
    0x1A: 'ERR_INVALID_DEVICE_ID',
}


# ---------------------------------------------------------------------------
# PASSTHRU_MSG struct (binary-compatible with J2534-2 spec)
# ---------------------------------------------------------------------------

class PASSTHRU_MSG(ctypes.Structure):
    _fields_ = [
        ('ProtocolID', ctypes.c_ulong),
        ('RxStatus', ctypes.c_ulong),
        ('TxFlags', ctypes.c_ulong),
        ('Timestamp', ctypes.c_ulong),
        ('DataSize', ctypes.c_ulong),
        ('ExtraDataIndex', ctypes.c_ulong),
        ('Data', ctypes.c_ubyte * 4128),
    ]


# ---------------------------------------------------------------------------
# J2534 DLL wrapper
# ---------------------------------------------------------------------------

class J2534Device:
    """Wraps a J2534 PassThru DLL via ctypes. Thread-safe via internal lock."""

    def __init__(self, dll_path, verbose=False):
        self.dll_path = dll_path
        self.verbose = verbose
        self.dll = None
        self.device_id = ctypes.c_ulong(0)
        self.channel_id = ctypes.c_ulong(0)
        self.is_open = False
        self.is_connected = False
        self._lock = threading.Lock()

        self.firmware_version = None
        self.dll_version = None
        self.api_version = None
        self.serial = None
        self.vendor_name = self._guess_vendor_name(dll_path)

    @staticmethod
    def _guess_vendor_name(path):
        name = os.path.basename(path).lower()
        if 'maxiflash' in name or 'autel' in name:
            return 'Autel MaxiFlash'
        if 'drewtech' in name or 'cardaq' in name:
            return 'Drew Tech CarDAQ'
        if 'mongoose' in name:
            return 'Drew Tech Mongoose'
        return 'J2534 Device'

    def load(self):
        if not os.path.exists(self.dll_path):
            raise FileNotFoundError(f'J2534 DLL not found at {self.dll_path}')

        if platform.system() == 'Windows':
            self.dll = ctypes.WinDLL(self.dll_path)
        else:
            self.dll = ctypes.CDLL(self.dll_path)

        self.dll.PassThruOpen.argtypes = [ctypes.c_void_p, ctypes.POINTER(ctypes.c_ulong)]
        self.dll.PassThruOpen.restype = ctypes.c_long

        self.dll.PassThruClose.argtypes = [ctypes.c_ulong]
        self.dll.PassThruClose.restype = ctypes.c_long

        self.dll.PassThruConnect.argtypes = [
            ctypes.c_ulong, ctypes.c_ulong, ctypes.c_ulong,
            ctypes.c_ulong, ctypes.POINTER(ctypes.c_ulong),
        ]
        self.dll.PassThruConnect.restype = ctypes.c_long

        self.dll.PassThruDisconnect.argtypes = [ctypes.c_ulong]
        self.dll.PassThruDisconnect.restype = ctypes.c_long

        self.dll.PassThruReadMsgs.argtypes = [
            ctypes.c_ulong, ctypes.POINTER(PASSTHRU_MSG),
            ctypes.POINTER(ctypes.c_ulong), ctypes.c_ulong,
        ]
        self.dll.PassThruReadMsgs.restype = ctypes.c_long

        self.dll.PassThruWriteMsgs.argtypes = [
            ctypes.c_ulong, ctypes.POINTER(PASSTHRU_MSG),
            ctypes.POINTER(ctypes.c_ulong), ctypes.c_ulong,
        ]
        self.dll.PassThruWriteMsgs.restype = ctypes.c_long

        self.dll.PassThruStartMsgFilter.argtypes = [
            ctypes.c_ulong, ctypes.c_ulong,
            ctypes.POINTER(PASSTHRU_MSG), ctypes.POINTER(PASSTHRU_MSG),
            ctypes.POINTER(PASSTHRU_MSG), ctypes.POINTER(ctypes.c_ulong),
        ]
        self.dll.PassThruStartMsgFilter.restype = ctypes.c_long

        self.dll.PassThruReadVersion.argtypes = [
            ctypes.c_ulong, ctypes.c_char_p, ctypes.c_char_p, ctypes.c_char_p,
        ]
        self.dll.PassThruReadVersion.restype = ctypes.c_long

        return True

    def _err(self, code):
        return ERRORS.get(code, f'UNKNOWN_0x{code:04X}')

    def open(self):
        with self._lock:
            if self.is_open:
                return True
            result = self.dll.PassThruOpen(None, ctypes.byref(self.device_id))
            if result != 0:
                raise RuntimeError(f'PassThruOpen failed: {self._err(result)}')
            self.is_open = True

            fw = ctypes.create_string_buffer(80)
            dll = ctypes.create_string_buffer(80)
            api = ctypes.create_string_buffer(80)
            try:
                r = self.dll.PassThruReadVersion(self.device_id, fw, dll, api)
                if r == 0:
                    self.firmware_version = fw.value.decode('ascii', errors='replace').strip()
                    self.dll_version = dll.value.decode('ascii', errors='replace').strip()
                    self.api_version = api.value.decode('ascii', errors='replace').strip()
            except Exception as e:
                if self.verbose:
                    print(f'[j2534] ReadVersion warning: {e}')
            return True

    def connect(self, protocol=PROTOCOL_ISO15765, flags=0, baudrate=500000):
        with self._lock:
            if not self.is_open:
                raise RuntimeError('Device not open')
            if self.is_connected:
                self._disconnect_locked()
            result = self.dll.PassThruConnect(
                self.device_id, protocol, flags, baudrate,
                ctypes.byref(self.channel_id),
            )
            if result != 0:
                raise RuntimeError(f'PassThruConnect failed: {self._err(result)}')
            self.is_connected = True
            return True

    def _disconnect_locked(self):
        if self.is_connected:
            self.dll.PassThruDisconnect(self.channel_id)
            self.is_connected = False
            self.channel_id = ctypes.c_ulong(0)

    def disconnect(self):
        with self._lock:
            self._disconnect_locked()
            return True

    def close(self):
        with self._lock:
            self._disconnect_locked()
            if self.is_open:
                self.dll.PassThruClose(self.device_id)
                self.is_open = False
            return True

    def write_msg(self, tx_id, data_bytes, flags=ISO15765_FRAME_PAD, timeout_ms=1000):
        with self._lock:
            if not self.is_connected:
                raise RuntimeError('Channel not connected')
            msg = PASSTHRU_MSG()
            msg.ProtocolID = PROTOCOL_ISO15765
            msg.TxFlags = flags
            id_bytes = [(tx_id >> 24) & 0xFF, (tx_id >> 16) & 0xFF,
                        (tx_id >> 8) & 0xFF, tx_id & 0xFF]
            payload = id_bytes + list(data_bytes)
            msg.DataSize = len(payload)
            for i, b in enumerate(payload):
                msg.Data[i] = b
            num_msgs = ctypes.c_ulong(1)
            result = self.dll.PassThruWriteMsgs(
                self.channel_id, ctypes.byref(msg),
                ctypes.byref(num_msgs), timeout_ms,
            )
            if result != 0:
                raise RuntimeError(f'PassThruWriteMsgs failed: {self._err(result)}')
            return True

    def read_msg(self, timeout_ms=1000, max_msgs=1):
        with self._lock:
            if not self.is_connected:
                raise RuntimeError('Channel not connected')
            msgs = (PASSTHRU_MSG * max_msgs)()
            num_msgs = ctypes.c_ulong(max_msgs)
            result = self.dll.PassThruReadMsgs(
                self.channel_id, msgs,
                ctypes.byref(num_msgs), timeout_ms,
            )
            if result == 0x09:
                return []
            if result not in (0, 0x10, 0x11):
                raise RuntimeError(f'PassThruReadMsgs failed: {self._err(result)}')
            out = []
            for i in range(num_msgs.value):
                m = msgs[i]
                raw = bytes(m.Data[:m.DataSize])
                if len(raw) >= 4:
                    rx_id = (raw[0] << 24) | (raw[1] << 16) | (raw[2] << 8) | raw[3]
                    payload = raw[4:]
                else:
                    rx_id = 0
                    payload = raw
                out.append({
                    'rx_id': rx_id,
                    'data': payload.hex(),
                    'rx_status': m.RxStatus,
                    'timestamp': m.Timestamp,
                })
            return out

    def set_flow_control_filter(self, tx_id, rx_id):
        with self._lock:
            if not self.is_connected:
                raise RuntimeError('Channel not connected')

            mask_msg = PASSTHRU_MSG()
            mask_msg.ProtocolID = PROTOCOL_ISO15765
            mask_msg.TxFlags = ISO15765_FRAME_PAD
            mask_msg.DataSize = 4
            for i, b in enumerate([0xFF, 0xFF, 0xFF, 0xFF]):
                mask_msg.Data[i] = b

            pattern_msg = PASSTHRU_MSG()
            pattern_msg.ProtocolID = PROTOCOL_ISO15765
            pattern_msg.TxFlags = ISO15765_FRAME_PAD
            pattern_msg.DataSize = 4
            pbytes = [(rx_id >> 24) & 0xFF, (rx_id >> 16) & 0xFF,
                      (rx_id >> 8) & 0xFF, rx_id & 0xFF]
            for i, b in enumerate(pbytes):
                pattern_msg.Data[i] = b

            flow_msg = PASSTHRU_MSG()
            flow_msg.ProtocolID = PROTOCOL_ISO15765
            flow_msg.TxFlags = ISO15765_FRAME_PAD
            flow_msg.DataSize = 4
            fbytes = [(tx_id >> 24) & 0xFF, (tx_id >> 16) & 0xFF,
                      (tx_id >> 8) & 0xFF, tx_id & 0xFF]
            for i, b in enumerate(fbytes):
                flow_msg.Data[i] = b

            filter_id = ctypes.c_ulong(0)
            result = self.dll.PassThruStartMsgFilter(
                self.channel_id, FLOW_CONTROL,
                ctypes.byref(mask_msg), ctypes.byref(pattern_msg),
                ctypes.byref(flow_msg), ctypes.byref(filter_id),
            )
            if result != 0:
                raise RuntimeError(f'PassThruStartMsgFilter failed: {self._err(result)}')
            return filter_id.value


# ---------------------------------------------------------------------------
# HTTP server
# ---------------------------------------------------------------------------

class BridgeHandler(BaseHTTPRequestHandler):
    device = None
    verbose = False

    def log_message(self, format, *args):
        if self.verbose:
            sys.stderr.write("[bridge] %s - %s\n" %
                             (self.address_string(), format % args))

    def _send_json(self, obj, status=200):
        body = json.dumps(obj).encode('utf-8')
        self.send_response(status)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Access-Control-Allow-Origin', '*')
        self.send_header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
        self.send_header('Access-Control-Allow-Headers', 'Content-Type')
        self.send_header('Content-Length', str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _read_body(self):
        length = int(self.headers.get('Content-Length', 0))
        if length == 0:
            return {}
        try:
            return json.loads(self.rfile.read(length).decode('utf-8'))
        except Exception:
            return {}

    def do_OPTIONS(self):
        self.send_response(204)
        self.send_header('Access-Control-Allow-Origin', '*')
        self.send_header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
        self.send_header('Access-Control-Allow-Headers', 'Content-Type')
        self.end_headers()

    def do_GET(self):
        path = urlparse(self.path).path
        if path == '/status':
            self._handle_status()
        else:
            self._send_json({'error': 'not found'}, 404)

    def do_POST(self):
        path = urlparse(self.path).path
        body = self._read_body()
        try:
            if path == '/open':
                self.device.open()
                self._send_json({'ok': True, 'device_id': self.device.device_id.value})
            elif path == '/connect':
                protocol = body.get('protocol', PROTOCOL_ISO15765)
                flags = body.get('flags', 0)
                baudrate = body.get('baudrate', 500000)
                self.device.connect(protocol, flags, baudrate)
                self._send_json({'ok': True, 'channel_id': self.device.channel_id.value})
            elif path == '/disconnect':
                self.device.disconnect()
                self._send_json({'ok': True})
            elif path == '/close':
                self.device.close()
                self._send_json({'ok': True})
            elif path == '/sendmsg':
                tx_id = int(body['tx_id'], 16) if isinstance(body['tx_id'], str) else body['tx_id']
                data = bytes.fromhex(body['data']) if isinstance(body['data'], str) else bytes(body['data'])
                flags = body.get('flags', ISO15765_FRAME_PAD)
                timeout = body.get('timeout_ms', 1000)
                self.device.write_msg(tx_id, data, flags, timeout)
                self._send_json({'ok': True})
            elif path == '/readmsg':
                timeout = body.get('timeout_ms', 1000)
                max_msgs = body.get('max_msgs', 1)
                msgs = self.device.read_msg(timeout, max_msgs)
                self._send_json({'ok': True, 'messages': msgs})
            elif path == '/setfilter':
                tx_id = int(body['tx_id'], 16) if isinstance(body['tx_id'], str) else body['tx_id']
                rx_id = int(body['rx_id'], 16) if isinstance(body['rx_id'], str) else body['rx_id']
                filter_id = self.device.set_flow_control_filter(tx_id, rx_id)
                self._send_json({'ok': True, 'filter_id': filter_id})
            else:
                self._send_json({'error': 'not found', 'path': path}, 404)
        except Exception as e:
            self._send_json({'ok': False, 'error': str(e)}, 500)

    def _handle_status(self):
        vci_info = None
        if self.device and self.device.is_open:
            vci_info = {
                'name': self.device.vendor_name,
                'serial': self.device.serial or 'unknown',
                'firmware': self.device.firmware_version,
                'dll_version': self.device.dll_version,
                'api_version': self.device.api_version,
                'is_connected': self.device.is_connected,
                'sgwCapable': 'maxiflash' in (self.device.vendor_name or '').lower(),
            }
        elif self.device:
            vci_info = {
                'name': self.device.vendor_name,
                'dll_path': self.device.dll_path,
                'is_open': False,
            }

        self._send_json({
            'ok': True,
            'version': '1.0.0',
            'bridge': 'srt-lab-j2534',
            'platform': platform.system(),
            'python': platform.python_version(),
            'vci': vci_info,
        })


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

def find_port(preferred):
    s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    try:
        s.bind(('127.0.0.1', preferred))
        s.close()
        return preferred
    except OSError:
        s.close()
        s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        s.bind(('127.0.0.1', 0))
        port = s.getsockname()[1]
        s.close()
        return port


def main():
    parser = argparse.ArgumentParser(description='SRT Lab J2534 Bridge')
    parser.add_argument('--dll', required=True,
                        help='Path to J2534 DLL (e.g. MaxiFlashJ2534.dll)')
    parser.add_argument('--port', type=int, default=8765)
    parser.add_argument('--verbose', action='store_true')
    parser.add_argument('--no-open', action='store_true',
                        help='Do not open device on startup')
    args = parser.parse_args()

    print('SRT Lab J2534 Bridge v1.0.0')
    print('=' * 60)
    print(f'Platform: {platform.system()} {platform.release()}')
    print(f'DLL:      {args.dll}')

    device = J2534Device(args.dll, verbose=args.verbose)

    try:
        device.load()
        print(f'[OK] DLL loaded ({device.vendor_name})')
    except Exception as e:
        print(f'[FAIL] DLL load failed: {e}')
        sys.exit(1)

    if not args.no_open:
        try:
            device.open()
            print(f'[OK] Device opened (ID {device.device_id.value})')
            if device.firmware_version:
                print(f'  Firmware: {device.firmware_version}')
            if device.dll_version:
                print(f'  DLL ver:  {device.dll_version}')
            if device.api_version:
                print(f'  API ver:  {device.api_version}')
        except Exception as e:
            print(f'[WARN] Device open failed (will retry on demand): {e}')

    port = find_port(args.port)
    if port != args.port:
        print(f'[WARN] Port {args.port} busy, using {port}')

    BridgeHandler.device = device
    BridgeHandler.verbose = args.verbose

    server = HTTPServer(('127.0.0.1', port), BridgeHandler)
    print(f'[OK] Listening on http://127.0.0.1:{port}')
    print('Endpoints: GET /status - POST /open /connect /sendmsg /readmsg /close /setfilter')
    print('Press Ctrl+C to stop')
    print('=' * 60)

    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print('\nShutting down...')
        try:
            device.close()
            print('[OK] Device closed')
        except Exception as e:
            print(f'  close warning: {e}')
        server.server_close()


if __name__ == '__main__':
    main()
