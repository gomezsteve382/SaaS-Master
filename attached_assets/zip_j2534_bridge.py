#!/usr/bin/env python3
"""
SRT Lab J2534 WebSocket Bridge
Bypasses ELM327 AT commands entirely — talks raw CAN via J2534 DLL.
Works with OBDLink EX, Autel MaxiSys, or any J2534 PassThru device.

Usage:
  1. Install: pip install websockets
  2. Run: python j2534_bridge.py
  3. Open SRT Lab in Chrome, click "Connect J2534"

WebSocket: ws://localhost:8765
"""

import asyncio
import json
import ctypes
from ctypes import c_ulong, c_long, c_void_p, POINTER, byref
import sys
import os
import time

try:
    import websockets
except ImportError:
    print("Installing websockets...")
    os.system(f"{sys.executable} -m pip install websockets")
    import websockets

# ═══════════════════════════════════════════════════
# J2534 Constants
# ═══════════════════════════════════════════════════
CAN = 5
ISO15765 = 6
CAN_29BIT_ID = 0x00000100
ISO15765_FRAME_PAD = 0x00000040
FLOW_CONTROL_FILTER = 3
PASS_FILTER = 1
CLEAR_MSG_FILTERS = 0x01
CLEAR_RX_BUFFER = 0x08

# Known FCA module addresses (from cda6_module_database.py + all project files)
FCA_MODULES = [
    (0x7E0, 0x7E8, "ECM/PCM"),
    (0x7E1, 0x7E9, "TCM"),
    (0x7E2, 0x7EA, "TCMP/DTCM"),
    (0x7E4, 0x7EC, "BPCM"),
    (0x750, 0x758, "BCM"),
    (0x75F, 0x767, "RFHUB/EPS"),
    (0x760, 0x768, "ABS"),
    (0x740, 0x748, "IPC"),
    (0x758, 0x760, "ORC"),
    (0x7A8, 0x7B0, "ADCM"),
    (0x7A0, 0x7A8, "AMP"),
    (0x770, 0x778, "BSM"),
    (0x742, 0x762, "BCM_ALT/RFHUB_ALT"),
    (0x745, 0x765, "IPC_ALT/SDM"),
    (0x744, 0x764, "ADM/SCCM"),
    (0x743, 0x763, "CCM"),
    (0x746, 0x766, "IPCM"),
    (0x747, 0x767, "ORC_ALT"),
    (0x74A, 0x76A, "EPS_ALT"),
    (0x74C, 0x76C, "TIPM"),
    (0x74F, 0x76F, "SGW"),
    (0x751, 0x759, "HVAC"),
    (0x752, 0x75A, "TPM"),
    (0x753, 0x773, "RADIO"),
    (0x754, 0x75C, "RADIO2"),
    (0x761, 0x769, "EPS2"),
    (0x772, 0x77A, "UCONNECT"),
    (0x7B0, 0x7B8, "BCM_SW"),
    (0x720, 0x728, "IPC_SW"),
    (0x7C0, 0x7C8, "CGW"),
    (0x7D0, 0x7D8, "RADIO_SW"),
    (0x6B0, 0x6B8, "BCM_DV"),
    (0x6C0, 0x6C8, "REAR_AXLE"),
]

class PASSTHRU_MSG(ctypes.Structure):
    _fields_ = [
        ("ProtocolID", c_ulong),
        ("RxStatus", c_ulong),
        ("TxFlags", c_ulong),
        ("Timestamp", c_ulong),
        ("DataSize", c_ulong),
        ("ExtraDataIndex", c_ulong),
        ("Data", ctypes.c_ubyte * 4128),
    ]

# ═══════════════════════════════════════════════════
# J2534 Interface
# ═══════════════════════════════════════════════════

class J2534:
    def __init__(self):
        self.dll = None
        self.device_id = c_ulong(0)
        self.channel_id = c_ulong(0)
        self.connected = False
        self.filters = []
    
    def find_devices(self):
        """Find all J2534 devices from Windows registry"""
        devices = []
        if sys.platform != 'win32':
            return devices
        
        import winreg
        base_paths = [
            r"SOFTWARE\PassThruSupport.04.04",
            r"SOFTWARE\WOW6432Node\PassThruSupport.04.04",
        ]
        
        for base in base_paths:
            try:
                key = winreg.OpenKey(winreg.HKEY_LOCAL_MACHINE, base)
                i = 0
                while True:
                    try:
                        subname = winreg.EnumKey(key, i)
                        subkey = winreg.OpenKey(key, subname)
                        try:
                            dll_path = winreg.QueryValueEx(subkey, "FunctionLibrary")[0]
                            name = winreg.QueryValueEx(subkey, "Name")[0]
                            if os.path.exists(dll_path):
                                devices.append({"name": name, "path": dll_path})
                        except:
                            pass
                        winreg.CloseKey(subkey)
                        i += 1
                    except:
                        break
                winreg.CloseKey(key)
            except:
                continue
        
        return devices
    
    def load(self, dll_path):
        """Load J2534 DLL"""
        try:
            self.dll = ctypes.WinDLL(dll_path) if sys.platform == 'win32' else ctypes.CDLL(dll_path)
            
            # PassThruOpen
            self.dll.PassThruOpen.argtypes = [c_void_p, POINTER(c_ulong)]
            self.dll.PassThruOpen.restype = c_long
            # PassThruClose
            self.dll.PassThruClose.argtypes = [c_ulong]
            self.dll.PassThruClose.restype = c_long
            # PassThruConnect
            self.dll.PassThruConnect.argtypes = [c_ulong, c_ulong, c_ulong, c_ulong, POINTER(c_ulong)]
            self.dll.PassThruConnect.restype = c_long
            # PassThruDisconnect
            self.dll.PassThruDisconnect.argtypes = [c_ulong]
            self.dll.PassThruDisconnect.restype = c_long
            # PassThruReadMsgs
            self.dll.PassThruReadMsgs.argtypes = [c_ulong, POINTER(PASSTHRU_MSG), POINTER(c_ulong), c_ulong]
            self.dll.PassThruReadMsgs.restype = c_long
            # PassThruWriteMsgs
            self.dll.PassThruWriteMsgs.argtypes = [c_ulong, POINTER(PASSTHRU_MSG), POINTER(c_ulong), c_ulong]
            self.dll.PassThruWriteMsgs.restype = c_long
            # PassThruStartMsgFilter
            self.dll.PassThruStartMsgFilter.argtypes = [c_ulong, c_ulong, POINTER(PASSTHRU_MSG), POINTER(PASSTHRU_MSG), POINTER(PASSTHRU_MSG), POINTER(c_ulong)]
            self.dll.PassThruStartMsgFilter.restype = c_long
            # PassThruStopMsgFilter
            self.dll.PassThruStopMsgFilter.argtypes = [c_ulong, c_ulong]
            self.dll.PassThruStopMsgFilter.restype = c_long
            # PassThruIoctl
            self.dll.PassThruIoctl.argtypes = [c_ulong, c_ulong, c_void_p, c_void_p]
            self.dll.PassThruIoctl.restype = c_long
            
            return True
        except Exception as e:
            print(f"Failed to load DLL: {e}")
            return False
    
    def open(self):
        ret = self.dll.PassThruOpen(None, byref(self.device_id))
        return ret == 0
    
    def close(self):
        if self.connected:
            self.disconnect()
        ret = self.dll.PassThruClose(self.device_id)
        self.device_id = c_ulong(0)
        return ret == 0
    
    def connect(self, protocol=ISO15765, baud=500000):
        ret = self.dll.PassThruConnect(self.device_id, protocol, 0, baud, byref(self.channel_id))
        if ret == 0:
            self.connected = True
        return ret == 0
    
    def disconnect(self):
        for fid in self.filters:
            try:
                self.dll.PassThruStopMsgFilter(self.channel_id, fid)
            except:
                pass
        self.filters = []
        ret = self.dll.PassThruDisconnect(self.channel_id)
        self.channel_id = c_ulong(0)
        self.connected = False
        return ret == 0
    
    def clear_filters(self):
        for fid in self.filters:
            try:
                self.dll.PassThruStopMsgFilter(self.channel_id, fid)
            except:
                pass
        self.filters = []
    
    def clear_rx(self):
        self.dll.PassThruIoctl(self.channel_id, CLEAR_RX_BUFFER, None, None)
    
    def setup_iso15765_filter(self, tx_id, rx_id):
        """Set up ISO-TP flow control filter for a TX/RX pair"""
        mask = PASSTHRU_MSG()
        mask.ProtocolID = ISO15765
        mask.DataSize = 4
        mask.Data[0] = 0xFF; mask.Data[1] = 0xFF; mask.Data[2] = 0xFF; mask.Data[3] = 0xFF
        
        pattern = PASSTHRU_MSG()
        pattern.ProtocolID = ISO15765
        pattern.DataSize = 4
        pattern.Data[0] = (rx_id >> 24) & 0xFF
        pattern.Data[1] = (rx_id >> 16) & 0xFF
        pattern.Data[2] = (rx_id >> 8) & 0xFF
        pattern.Data[3] = rx_id & 0xFF
        
        fc = PASSTHRU_MSG()
        fc.ProtocolID = ISO15765
        fc.TxFlags = ISO15765_FRAME_PAD
        fc.DataSize = 4
        fc.Data[0] = (tx_id >> 24) & 0xFF
        fc.Data[1] = (tx_id >> 16) & 0xFF
        fc.Data[2] = (tx_id >> 8) & 0xFF
        fc.Data[3] = tx_id & 0xFF
        
        fid = c_ulong(0)
        ret = self.dll.PassThruStartMsgFilter(
            self.channel_id, FLOW_CONTROL_FILTER,
            byref(mask), byref(pattern), byref(fc), byref(fid)
        )
        if ret == 0:
            self.filters.append(fid.value)
        return ret == 0
    
    def send_uds(self, tx_id, data, timeout=2000):
        """Send UDS request"""
        msg = PASSTHRU_MSG()
        msg.ProtocolID = ISO15765
        msg.TxFlags = ISO15765_FRAME_PAD
        msg.DataSize = 4 + len(data)
        msg.Data[0] = (tx_id >> 24) & 0xFF
        msg.Data[1] = (tx_id >> 16) & 0xFF
        msg.Data[2] = (tx_id >> 8) & 0xFF
        msg.Data[3] = tx_id & 0xFF
        for i, b in enumerate(data):
            msg.Data[4 + i] = b
        
        num = c_ulong(1)
        ret = self.dll.PassThruWriteMsgs(self.channel_id, byref(msg), byref(num), timeout)
        return ret == 0
    
    def recv_uds(self, timeout=2000):
        """Read UDS response"""
        msg = PASSTHRU_MSG()
        num = c_ulong(1)
        ret = self.dll.PassThruReadMsgs(self.channel_id, byref(msg), byref(num), timeout)
        
        if ret == 0 and num.value > 0 and msg.DataSize > 4:
            can_id = (msg.Data[0] << 24) | (msg.Data[1] << 16) | (msg.Data[2] << 8) | msg.Data[3]
            data = [msg.Data[i] for i in range(4, msg.DataSize)]
            return {"canId": can_id, "data": data}
        return None
    
    def uds_request(self, tx_id, rx_id, data, timeout=2000):
        """Full UDS request/response cycle"""
        self.clear_filters()
        self.clear_rx()
        
        if not self.setup_iso15765_filter(tx_id, rx_id):
            return None
        
        if not self.send_uds(tx_id, data, timeout):
            return None
        
        # Read responses, handling 0x78 (responsePending)
        deadline = time.time() + (timeout / 1000.0) + 2
        while time.time() < deadline:
            resp = self.recv_uds(timeout)
            if not resp:
                return None
            
            # Skip flow control frames and non-data
            if resp["canId"] != rx_id:
                continue
            
            d = resp["data"]
            if len(d) >= 3 and d[0] == 0x7F and d[2] == 0x78:
                # responsePending — keep reading
                continue
            
            return resp
        
        return None
    
    def scan_module(self, tx_id, rx_id, name=""):
        """Probe a single module — try TesterPresent, then Read VIN"""
        # Try TesterPresent first
        resp = self.uds_request(tx_id, rx_id, [0x3E, 0x00], 1500)
        if resp and resp["data"]:
            d = resp["data"]
            if d[0] == 0x7E or (d[0] == 0x7F and d[2] != 0x11):
                # Module alive — try reading VIN
                vin_resp = self.uds_request(tx_id, rx_id, [0x22, 0xF1, 0x90], 2000)
                vin = None
                if vin_resp and len(vin_resp["data"]) > 3:
                    vin_bytes = [b for b in vin_resp["data"] if 0x20 <= b <= 0x7E]
                    vin_str = ''.join(chr(b) for b in vin_bytes)
                    if len(vin_str) >= 10:
                        vin = vin_str[-17:]
                return {"found": True, "tx": tx_id, "rx": rx_id, "name": name, "vin": vin}
        
        # Also try Read VIN directly (body modules prefer this)
        resp = self.uds_request(tx_id, rx_id, [0x22, 0xF1, 0x90], 1500)
        if resp and resp["data"]:
            d = resp["data"]
            if d[0] == 0x62:  # Positive response to ReadDID
                vin_bytes = [b for b in d if 0x20 <= b <= 0x7E]
                vin_str = ''.join(chr(b) for b in vin_bytes)
                vin = vin_str[-17:] if len(vin_str) >= 10 else None
                return {"found": True, "tx": tx_id, "rx": rx_id, "name": name, "vin": vin}
            elif d[0] == 0x7F and d[2] != 0x11:
                # Negative response but NOT "service not supported" = module exists
                return {"found": True, "tx": tx_id, "rx": rx_id, "name": name, "vin": None}
        
        return {"found": False, "tx": tx_id, "rx": rx_id, "name": name}
    
    def full_scan(self, callback=None):
        """Scan all known FCA module addresses"""
        results = []
        for tx, rx, name in FCA_MODULES:
            if callback:
                callback(f"Probing {name} (TX:0x{tx:03X} RX:0x{rx:03X})...")
            
            result = self.scan_module(tx, rx, name)
            if result["found"]:
                results.append(result)
                if callback:
                    vin = result.get("vin", "?")
                    callback(f"FOUND {name} at TX:0x{tx:03X} VIN:{vin}")
        
        return results


# ═══════════════════════════════════════════════════
# WebSocket Server
# ═══════════════════════════════════════════════════

j2534 = J2534()

async def handle_client(websocket):
    print("Client connected")
    
    try:
        async for message in websocket:
            try:
                cmd = json.loads(message)
                response = {"success": False, "command": cmd.get("command", "")}
                
                command = cmd["command"]
                
                if command == "ListDevices":
                    devices = j2534.find_devices()
                    response["success"] = True
                    response["devices"] = devices
                
                elif command == "Open":
                    dll_path = cmd.get("dllPath")
                    if not dll_path:
                        devices = j2534.find_devices()
                        if devices:
                            dll_path = devices[0]["path"]
                            response["deviceName"] = devices[0]["name"]
                    
                    if dll_path and j2534.load(dll_path):
                        if j2534.open():
                            response["success"] = True
                
                elif command == "Connect":
                    baud = cmd.get("baudRate", 500000)
                    response["success"] = j2534.connect(ISO15765, baud)
                
                elif command == "Close":
                    response["success"] = j2534.close()
                
                elif command == "UDS":
                    tx = cmd["txId"]
                    rx = cmd["rxId"]
                    data = cmd["data"]
                    timeout = cmd.get("timeout", 2000)
                    
                    resp = j2534.uds_request(tx, rx, data, timeout)
                    if resp:
                        response["success"] = True
                        response["data"] = resp["data"]
                        response["canId"] = resp["canId"]
                
                elif command == "Scan":
                    found = []
                    
                    async def scan_cb(msg):
                        await websocket.send(json.dumps({"type": "scanProgress", "message": msg}))
                    
                    # Can't use async callback directly in sync scan, so run in executor
                    import concurrent.futures
                    loop = asyncio.get_event_loop()
                    
                    def sync_scan():
                        results = []
                        for tx, rx, name in FCA_MODULES:
                            result = j2534.scan_module(tx, rx, name)
                            results.append(result)
                        return results
                    
                    with concurrent.futures.ThreadPoolExecutor() as pool:
                        results = await loop.run_in_executor(pool, sync_scan)
                    
                    found = [r for r in results if r["found"]]
                    response["success"] = True
                    response["found"] = found
                    response["total"] = len(FCA_MODULES)
                
                elif command == "ScanOne":
                    tx = cmd["txId"]
                    rx = cmd["rxId"]
                    name = cmd.get("name", f"0x{tx:03X}")
                    result = j2534.scan_module(tx, rx, name)
                    response["success"] = True
                    response["result"] = result
                
                await websocket.send(json.dumps(response))
                
            except Exception as e:
                await websocket.send(json.dumps({"success": False, "error": str(e)}))
    
    except websockets.exceptions.ConnectionClosed:
        print("Client disconnected")

async def main():
    print("=" * 60)
    print("SRT LAB — J2534 WebSocket Bridge")
    print("=" * 60)
    
    devices = j2534.find_devices()
    if devices:
        print(f"\nFound {len(devices)} J2534 device(s):")
        for d in devices:
            print(f"  • {d['name']}")
            print(f"    {d['path']}")
    else:
        print("\nNo J2534 devices found in registry.")
        print("Make sure OBDLink or Autel drivers are installed.")
        if sys.platform == 'win32':
            print("\nLooking for OBDLink in common locations...")
            common = [
                r"C:\Program Files (x86)\OBDLink\OBDLink.dll",
                r"C:\Program Files\OBDLink\OBDLink.dll",
                r"C:\Program Files (x86)\ScanTool.net\OBDLink\passthru.dll",
            ]
            for p in common:
                if os.path.exists(p):
                    print(f"  Found: {p}")
                    devices = [{"name": "OBDLink", "path": p}]
                    break
    
    print(f"\nStarting WebSocket server on ws://localhost:8765")
    print("Open SRT Lab in Chrome and click 'Connect J2534'")
    print("Press Ctrl+C to stop.\n")
    
    async with websockets.serve(handle_client, "localhost", 8765):
        await asyncio.Future()

if __name__ == "__main__":
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        print("\nShutting down...")
        if j2534.connected:
            j2534.close()
