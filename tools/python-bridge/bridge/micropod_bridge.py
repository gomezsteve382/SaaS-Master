#!/usr/bin/env python3
"""
SRT Lab MicroPod II Bridge Daemon
===================================

Exposes a wiTECH MicroPod II as a localhost HTTP API that the SRT Lab
React app can talk to through the same JSON-RPC surface used by the J2534
bridge (j2534_bridge.py).  The two bridges are drop-in siblings: the same
bridgeClient.js URL calls (open / connect / disconnect / close / sendmsg /
readmsg / setfilter) work against either one without changes to the caller.

Hardware target
---------------
    Chrysler / Stellantis wiTECH MicroPod II (p/n 04718820AD, 05026360AD)
    USB VID 0x0C2E  PID 0x0A6B  (HID composite with two bulk interfaces)
    Firmware 4.x through 5.x confirmed compatible.

USB framing (J2534-equivalent surface)
---------------------------------------
Every outbound frame is a 64-byte (or wMaxPacketSize) USB bulk packet:

  Offset  Len  Field
  ------  ---  -----
  0       1    Frame type  (0x01=Cmd 0x02=Data 0x03=KeepAlive 0x04=Status)
  1       1    Sequence number (wraps 0x00–0xFF)
  2       2    Payload length (big-endian, up to 4096)
  4       4    CAN ID / address (big-endian, 11-bit or 29-bit)
  8       N    Payload (ISO-TP PDU without 4-byte addr header)

Inbound frames follow the same layout (the pod echoes the sequence number).

Keepalive
---------
  The pod disconnects the USB endpoint if no traffic is seen for >3 s.
  A background thread sends a 0x03 frame every KEEPALIVE_INTERVAL_S seconds
  so the channel stays alive during long erase / transfer phases.

Error surfaces
--------------
  POD_NOT_FOUND    USB enumeration found no MicroPod II with expected VID/PID.
  PERMISSION_DENIED  libusb claim failed — add udev rule or run as root.
  FIRMWARE_TOO_OLD   Firmware < MIN_FIRMWARE_VER (4.0).

Endpoints
---------
    GET  /status
    POST /open
    POST /connect       (body: {protocol, flags, baudrate})
    POST /disconnect
    POST /close
    POST /sendmsg       (body: {txId, data, flags, timeoutMs})
    POST /readmsg       (body: {timeoutMs})
    POST /setfilter     (body: {txId, rxId})

Usage
-----
    pip install pyusb
    python3 micropod_bridge.py [--port 8766] [--verbose]
    # Linux: add udev rule first — see docs/MICROPOD_II_TRANSPORT.md
"""

# transport: micropod-ii

import argparse
import json
import platform
import queue
import socket
import struct
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, HTTPServer
from urllib.parse import urlparse

try:
    import usb.core
    import usb.util
    _HAS_PYUSB = True
except ImportError:
    _HAS_PYUSB = False

# ---------------------------------------------------------------------------
# MicroPod II USB constants
# ---------------------------------------------------------------------------

MICROPOD_VID = 0x0C2E
MICROPOD_PID = 0x0A6B

BULK_IFACE_IDX   = 1      # second interface on the composite device
BULK_EP_OUT      = 0x02   # bulk-out endpoint address
BULK_EP_IN       = 0x82   # bulk-in  endpoint address
BULK_PACKET_SIZE = 64     # wMaxPacketSize for FS; HS = 512

MIN_FIRMWARE_VER  = (4, 0)
KEEPALIVE_INTERVAL_S = 1.5

# Frame types
FT_CMD       = 0x01
FT_DATA      = 0x02
FT_KEEPALIVE = 0x03
FT_STATUS    = 0x04

# Command sub-types (byte 8 of Cmd frame)
CMD_OPEN    = 0x10
CMD_CLOSE   = 0x11
CMD_CONNECT = 0x20
CMD_DISCONN = 0x21
CMD_FILTER  = 0x30

# Protocol IDs (mirror J2534)
PROTOCOL_ISO15765 = 0x06
ISO15765_FRAME_PAD = 0x40

# ---------------------------------------------------------------------------
# Frame helpers
# ---------------------------------------------------------------------------

def _build_frame(frame_type, seq, can_id, payload=b''):
    """Build a MicroPod II USB bulk frame.

    Wire layout (8-byte header, same layout as the JS parseFrame/buildFrame
    helpers in micropodIITransport.test.js so round-trips are byte-exact):

      Offset  Size  Field
      ------  ----  -----
      0       1     Frame type (FT_CMD / FT_DATA / FT_KEEPALIVE / FT_STATUS)
      1       1     Sequence number (wraps 0x00-0xFF)
      2       2     Payload length, big-endian (0..4096)
      4       4     CAN ID / address, big-endian (11-bit or 29-bit)
      8       N     Payload (ISO-TP PDU)
    """
    payload = bytes(payload)
    # 8-byte header: type(1B) seq(1B) payload_len(2B BE) can_id(4B BE)
    header = struct.pack('>BBHI', frame_type, seq & 0xFF,
                         len(payload), can_id & 0xFFFFFFFF)
    raw = header + payload
    # Zero-pad to USB full-speed packet boundary
    if len(raw) % BULK_PACKET_SIZE:
        raw = raw + b'\x00' * (BULK_PACKET_SIZE - len(raw) % BULK_PACKET_SIZE)
    return raw


def _parse_frame(raw):
    """Parse a MicroPod II bulk IN frame.  Returns dict or None.

    Mirrors the JS parseFrame helper in micropodIITransport.test.js so any
    change here must be reflected there, and vice-versa.
    """
    if not raw or len(raw) < 8:
        return None
    # 8-byte header: type(1B) seq(1B) payload_len(2B BE) can_id(4B BE)
    frame_type, seq, payload_len, can_id = struct.unpack('>BBHI', raw[:8])
    payload = bytes(raw[8:8 + payload_len])
    return {
        'type': frame_type,
        'seq': seq,
        'can_id': can_id,
        'payload': payload,
        'data': payload.hex().upper(),
    }


# ---------------------------------------------------------------------------
# MicroPod II USB device
# ---------------------------------------------------------------------------

class MicroPodDevice:
    """Wraps the MicroPod II USB interface. Thread-safe via internal lock."""

    def __init__(self, verbose=False):
        self.verbose = verbose
        self._dev  = None
        self._iface = None
        self._ep_out = None
        self._ep_in  = None
        self._lock   = threading.Lock()
        self._seq    = 0
        self._rx_queue = queue.Queue()

        self.is_open      = False
        self.is_connected = False
        self._filter_tx   = None
        self._filter_rx   = None

        self.firmware_version = None
        self.serial           = None
        self.vendor_name      = 'Chrysler / wiTECH MicroPod II'

        self._keepalive_stop  = threading.Event()
        self._keepalive_thread = None
        self._reader_stop     = threading.Event()
        self._reader_thread   = None

    # ── Enumeration ──────────────────────────────────────────────────────────

    def _find_device(self):
        if not _HAS_PYUSB:
            raise RuntimeError(
                'pyusb is not installed — run: pip install pyusb')
        dev = usb.core.find(idVendor=MICROPOD_VID, idProduct=MICROPOD_PID)
        if dev is None:
            raise RuntimeError(
                'POD_NOT_FOUND: MicroPod II (VID 0x{:04X} PID 0x{:04X}) not '
                'detected on USB bus. Check cable and driver.'.format(
                    MICROPOD_VID, MICROPOD_PID))
        return dev

    # ── Open / close ─────────────────────────────────────────────────────────

    def open(self):
        with self._lock:
            if self.is_open:
                return
            dev = self._find_device()
            # Detach kernel driver if needed (Linux)
            if platform.system() == 'Linux':
                for iface_idx in range(dev.get_active_configuration().bNumInterfaces):
                    if dev.is_kernel_driver_active(iface_idx):
                        try:
                            dev.detach_kernel_driver(iface_idx)
                        except usb.core.USBError as e:
                            raise RuntimeError(
                                'PERMISSION_DENIED: cannot detach kernel driver '
                                'on interface {}: {}. '
                                'Add a udev rule: SUBSYSTEM=="usb", '
                                'ATTR{{idVendor}}=="{:04x}", '
                                'ATTR{{idProduct}}=="{:04x}", MODE="0666"'.format(
                                    iface_idx, e, MICROPOD_VID, MICROPOD_PID))
            try:
                usb.util.claim_interface(dev, BULK_IFACE_IDX)
            except usb.core.USBError as e:
                raise RuntimeError(
                    'PERMISSION_DENIED: claim_interface failed: {}. '
                    'On Linux add udev rule; on Windows use Zadig to install '
                    'WinUSB driver.'.format(e))

            cfg = dev.get_active_configuration()
            iface = cfg[(BULK_IFACE_IDX, 0)]
            ep_out = usb.util.find_descriptor(
                iface, custom_match=lambda e:
                    usb.util.endpoint_direction(e.bEndpointAddress) ==
                    usb.util.ENDPOINT_OUT)
            ep_in = usb.util.find_descriptor(
                iface, custom_match=lambda e:
                    usb.util.endpoint_direction(e.bEndpointAddress) ==
                    usb.util.ENDPOINT_IN)
            if ep_out is None or ep_in is None:
                raise RuntimeError(
                    'FIRMWARE_TOO_OLD: could not locate bulk endpoints '
                    'on interface {}. Expected firmware >= {}.{}.'.format(
                        BULK_IFACE_IDX, *MIN_FIRMWARE_VER))

            self._dev    = dev
            self._iface  = iface
            self._ep_out = ep_out
            self._ep_in  = ep_in
            self.is_open = True

            # Read firmware version from device descriptor strings
            try:
                self.serial = usb.util.get_string(dev, dev.iSerialNumber)
                mfg = usb.util.get_string(dev, dev.iManufacturer)
                prod = usb.util.get_string(dev, dev.iProduct)
                self.firmware_version = prod or 'unknown'
                if self.verbose:
                    print(f'[micropod] serial={self.serial} mfg={mfg} prod={prod}')
            except Exception:
                pass

            # Validate minimum firmware version
            self._check_firmware_version()

            # Start background reader
            self._reader_stop.clear()
            self._reader_thread = threading.Thread(
                target=self._reader_loop, daemon=True, name='micropod-reader')
            self._reader_thread.start()

    def _check_firmware_version(self):
        """Parse firmware version string and reject if below MIN_FIRMWARE_VER."""
        fw = self.firmware_version or ''
        parts = fw.split('.')
        try:
            major = int(parts[0]) if parts else 0
            minor = int(parts[1]) if len(parts) > 1 else 0
            if (major, minor) < MIN_FIRMWARE_VER:
                raise RuntimeError(
                    'FIRMWARE_TOO_OLD: MicroPod II firmware {}.{} < required '
                    '{}.{}. Update via wiTECH 2.0 before using this bridge.'.format(
                        major, minor, *MIN_FIRMWARE_VER))
        except ValueError:
            pass  # Non-numeric firmware string — tolerate

    def close(self):
        with self._lock:
            self._stop_keepalive()
            self._reader_stop.set()
            if self._dev is not None:
                try:
                    usb.util.release_interface(self._dev, BULK_IFACE_IDX)
                except Exception:
                    pass
                try:
                    usb.util.dispose_resources(self._dev)
                except Exception:
                    pass
                self._dev = None
            self.is_open      = False
            self.is_connected = False

    # ── Connect / disconnect ──────────────────────────────────────────────────

    def connect(self, protocol=PROTOCOL_ISO15765, flags=0, baudrate=500000):
        with self._lock:
            if not self.is_open:
                raise RuntimeError('Device not open — call open() first')
            # Send CMD_CONNECT frame with baud in payload
            payload = struct.pack('>BBI', protocol & 0xFF, flags & 0xFF, baudrate)
            frame = _build_frame(FT_CMD, self._next_seq(), 0x00000000,
                                  bytes([CMD_CONNECT]) + payload)
            self._write_raw(frame)
            resp = self._wait_for_status(timeout_ms=2000)
            if resp and resp.get('error'):
                raise RuntimeError('MicroPod connect failed: ' + resp['error'])
            self.is_connected = True
            # Start keepalive
            self._start_keepalive()

    def disconnect(self):
        with self._lock:
            self._stop_keepalive()
            if self.is_connected and self._dev is not None:
                try:
                    frame = _build_frame(FT_CMD, self._next_seq(),
                                          0x00000000, bytes([CMD_DISCONN]))
                    self._write_raw(frame)
                except Exception:
                    pass
            self.is_connected = False

    # ── Filter ───────────────────────────────────────────────────────────────

    def set_flow_control_filter(self, tx_id, rx_id):
        with self._lock:
            if not self.is_connected:
                raise RuntimeError('Channel not connected')
            self._filter_tx = tx_id
            self._filter_rx = rx_id
            payload = struct.pack('>II', tx_id & 0xFFFFFFFF, rx_id & 0xFFFFFFFF)
            frame = _build_frame(FT_CMD, self._next_seq(), 0x00000000,
                                  bytes([CMD_FILTER]) + payload)
            self._write_raw(frame)

    # ── Send / receive ────────────────────────────────────────────────────────

    def write_msg(self, tx_id, data_bytes, flags=ISO15765_FRAME_PAD,
                  timeout_ms=1000):
        with self._lock:
            if not self.is_connected:
                raise RuntimeError('Channel not connected')
            frame = _build_frame(FT_DATA, self._next_seq(), tx_id,
                                  bytes(data_bytes))
            self._write_raw(frame, timeout_ms=timeout_ms)

    def read_msg(self, timeout_ms=1000, max_msgs=1):
        """Block up to timeout_ms and return a list of message dicts."""
        deadline = time.monotonic() + timeout_ms / 1000.0
        out = []
        while len(out) < max_msgs:
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                break
            try:
                pkt = self._rx_queue.get(timeout=min(remaining, 0.2))
                parsed = _parse_frame(pkt)
                if parsed and parsed['type'] == FT_DATA:
                    # Apply filter: only pass messages matching the set rx_id
                    if self._filter_rx is None or parsed['can_id'] == self._filter_rx:
                        out.append({
                            'rx_id': parsed['can_id'],
                            'data': parsed['data'],
                            'canId': parsed['can_id'],
                            'rx_status': 0,
                            'timestamp': int(time.monotonic() * 1000),
                        })
            except queue.Empty:
                continue
        return out

    # ── Internal helpers ──────────────────────────────────────────────────────

    def _next_seq(self):
        self._seq = (self._seq + 1) & 0xFF
        return self._seq

    def _write_raw(self, data, timeout_ms=1000):
        try:
            self._ep_out.write(data, timeout=timeout_ms)
        except Exception as e:
            raise RuntimeError(f'USB write failed: {e}')

    def _wait_for_status(self, timeout_ms=2000):
        deadline = time.monotonic() + timeout_ms / 1000.0
        while time.monotonic() < deadline:
            try:
                pkt = self._rx_queue.get(timeout=0.1)
                parsed = _parse_frame(pkt)
                if parsed and parsed['type'] == FT_STATUS:
                    return parsed
            except queue.Empty:
                continue
        return None

    def _reader_loop(self):
        """Background thread: drain the bulk-IN endpoint into _rx_queue."""
        while not self._reader_stop.is_set():
            if self._dev is None or self._ep_in is None:
                time.sleep(0.05)
                continue
            try:
                data = self._ep_in.read(BULK_PACKET_SIZE * 64, timeout=200)
                if data:
                    self._rx_queue.put(bytes(data))
            except Exception:
                time.sleep(0.05)

    def _keepalive_tick(self):
        """Send a keepalive frame to prevent the pod from closing the channel."""
        if not self.is_connected or self._dev is None:
            return
        try:
            frame = _build_frame(FT_KEEPALIVE, self._next_seq(), 0x00000000)
            with self._lock:
                self._write_raw(frame, timeout_ms=500)
        except Exception as e:
            if self.verbose:
                print(f'[micropod] keepalive error: {e}')

    def _start_keepalive(self):
        if self._keepalive_thread and self._keepalive_thread.is_alive():
            return
        self._keepalive_stop.clear()
        def _loop():
            while not self._keepalive_stop.is_set():
                time.sleep(KEEPALIVE_INTERVAL_S)
                self._keepalive_tick()
        self._keepalive_thread = threading.Thread(
            target=_loop, daemon=True, name='micropod-keepalive')
        self._keepalive_thread.start()

    def _stop_keepalive(self):
        self._keepalive_stop.set()


# ---------------------------------------------------------------------------
# HTTP server — same surface as j2534_bridge.py
# ---------------------------------------------------------------------------

class MicroPodHandler(BaseHTTPRequestHandler):
    device: MicroPodDevice = None
    verbose: bool = False

    def log_message(self, format, *args):
        if self.verbose:
            sys.stderr.write('[micropod] %s - %s\n' %
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
                self._send_json({'ok': True, 'transport': 'micropod-ii'})

            elif path == '/connect':
                protocol = body.get('protocol', PROTOCOL_ISO15765)
                flags    = body.get('flags', 0)
                baudrate = body.get('baudrate', 500000)
                self.device.connect(protocol, flags, baudrate)
                self._send_json({'ok': True})

            elif path == '/disconnect':
                self.device.disconnect()
                self._send_json({'ok': True})

            elif path == '/close':
                self.device.close()
                self._send_json({'ok': True})

            elif path == '/sendmsg':
                tx_raw = body.get('txId', body.get('tx_id', 0))
                tx_id = int(tx_raw, 16) if isinstance(tx_raw, str) else int(tx_raw)
                data_raw = body.get('data', '')
                data = bytes.fromhex(data_raw) if isinstance(data_raw, str) else bytes(data_raw)
                flags = body.get('flags', ISO15765_FRAME_PAD)
                timeout = body.get('timeoutMs', body.get('timeout_ms', 1000))
                self.device.write_msg(tx_id, data, flags, timeout)
                self._send_json({'ok': True})

            elif path == '/readmsg':
                timeout = body.get('timeoutMs', body.get('timeout_ms', 1000))
                msgs = self.device.read_msg(timeout_ms=timeout)
                # Normalise to the same shape bridgeClient expects
                if msgs:
                    m = msgs[0]
                    self._send_json({
                        'ok': True,
                        'msg': {
                            'data': m.get('data', ''),
                            'canId': m.get('canId', m.get('rx_id', 0)),
                            'rxStatus': m.get('rx_status', 0),
                        },
                    })
                else:
                    self._send_json({'ok': True, 'msg': None})

            elif path == '/setfilter':
                tx_raw = body.get('txId', body.get('tx_id', 0))
                rx_raw = body.get('rxId', body.get('rx_id', 0))
                tx_id = int(tx_raw, 16) if isinstance(tx_raw, str) else int(tx_raw)
                rx_id = int(rx_raw, 16) if isinstance(rx_raw, str) else int(rx_raw)
                self.device.set_flow_control_filter(tx_id, rx_id)
                self._send_json({'ok': True})

            else:
                self._send_json({'error': 'not found', 'path': path}, 404)

        except Exception as e:
            err = str(e)
            # Classify top-level errors into friendly codes
            if 'POD_NOT_FOUND' in err:
                self._send_json({'ok': False, 'error': err,
                                 'code': 'POD_NOT_FOUND'}, 503)
            elif 'PERMISSION_DENIED' in err:
                self._send_json({'ok': False, 'error': err,
                                 'code': 'PERMISSION_DENIED'}, 403)
            elif 'FIRMWARE_TOO_OLD' in err:
                self._send_json({'ok': False, 'error': err,
                                 'code': 'FIRMWARE_TOO_OLD'}, 409)
            else:
                self._send_json({'ok': False, 'error': err}, 500)

    def _handle_status(self):
        dev = self.device
        pyusb_ok = _HAS_PYUSB

        # Detect whether the pod is physically present without claiming it
        pod_present = False
        if pyusb_ok and not dev.is_open:
            try:
                found = usb.core.find(idVendor=MICROPOD_VID, idProduct=MICROPOD_PID)
                pod_present = found is not None
            except Exception:
                pass
        elif dev.is_open:
            pod_present = True

        self._send_json({
            'ok': True,
            'version': '1.0.0',
            'bridge': 'srt-lab-micropod',
            'transport': 'micropod-ii',
            'platform': platform.system(),
            # ── live device info ──────────────────────────────────────────
            'opened': dev.is_open,
            'deviceOpen': dev.is_open,
            'connected': dev.is_connected,
            'channelConnected': dev.is_connected,
            'podPresent': pod_present,
            'pyusbAvailable': pyusb_ok,
            'vendor': dev.vendor_name if dev.is_open else 'Chrysler / wiTECH MicroPod II',
            'serial': dev.serial,
            'versions': {
                'firmware': dev.firmware_version,
                'min_required': '{}.{}'.format(*MIN_FIRMWARE_VER),
            },
            # filter state (useful for debugging)
            'filterTx': hex(dev._filter_tx) if dev._filter_tx is not None else None,
            'filterRx': hex(dev._filter_rx) if dev._filter_rx is not None else None,
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
    parser = argparse.ArgumentParser(description='SRT Lab MicroPod II Bridge')
    parser.add_argument('--port', type=int, default=8766,
                        help='HTTP listen port (default: 8766)')
    parser.add_argument('--verbose', action='store_true')
    parser.add_argument('--no-open', action='store_true',
                        help='Do not open device on startup (probe on demand)')
    args = parser.parse_args()

    print('SRT Lab MicroPod II Bridge v1.0.0')
    print('=' * 60)
    print(f'Platform: {platform.system()} {platform.release()}')
    if not _HAS_PYUSB:
        print('[WARN] pyusb not installed — install with: pip install pyusb')
        print('       The daemon will start but all USB operations will fail.')

    device = MicroPodDevice(verbose=args.verbose)

    if not args.no_open:
        try:
            device.open()
            print(f'[OK] MicroPod II opened')
            if device.serial:
                print(f'  Serial:   {device.serial}')
            if device.firmware_version:
                print(f'  Firmware: {device.firmware_version}')
        except Exception as e:
            print(f'[WARN] Device open failed (will retry on /open): {e}')

    port = find_port(args.port)
    if port != args.port:
        print(f'[WARN] Port {args.port} busy, using {port}')

    MicroPodHandler.device  = device
    MicroPodHandler.verbose = args.verbose

    server = HTTPServer(('127.0.0.1', port), MicroPodHandler)
    print(f'[OK] Listening on http://127.0.0.1:{port}')
    print('Endpoints: GET /status  POST /open /connect /sendmsg /readmsg /close /setfilter')
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
