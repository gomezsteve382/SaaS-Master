# Source Generated with Decompyle++
# File: main.pyc (Python 3.12)

import base64
import json
import os
import sys
import hashlib
import ctypes
from ctypes import wintypes
import threading
import socketserver
import http.server as http
import subprocess
import webview
import time
import re

try:
    import serial
    from serial.tools import list_ports
    _HEX2 = re.compile('^[0-9A-Fa-f]{2}$')
    _HEXID = re.compile('^[0-9A-Fa-f]{3,8}$')
    
    def _to_int_hex(v, default_int):
        pass
    # WARNING: Decompyle incomplete

    
    def _to_bus(v, default_bus):
        if not v:
            v
        s = str('').lower().strip()
        if s in ('hs', 'ms'):
            return s

    
    def _hex_bytes_from_elm_text(text = None):
        out = []
        if not text:
            text
    # WARNING: Decompyle incomplete

    
    def _looks_like_uds_payload(payload):
        
        try:
            if not payload:
                return False
                
                try:
                    b0 = int(payload[0]) & 255
                    return b0 in (80, 98, 110, 127)
                except Exception:
                    return False



    
    def _elm_extract_isotp_payload(raw_bytes, expected_can_id = (None,)):
        pass
    # WARNING: Decompyle incomplete

    _ECU_MAP_CACHE = {
        'mtime': None,
        'data': None,
        'err': None }
    
    def _runtime_base_dir():
        
        try:
            return os.path.dirname(os.path.abspath(sys.argv[0]))
        except Exception:
            return 


    
    def load_obd_ecu_map(force = (False,)):
        pass
    # WARNING: Decompyle incomplete

    
    def list_j2534_devices():
        if sys.platform != 'win32':
            return []
        import winreg
        roots = [
            'SOFTWARE\\PassThruSupport.04.04',
            'SOFTWARE\\WOW6432Node\\PassThruSupport.04.04']
        devices = []
        seen = set()
        for root_path in roots:
            root = winreg.OpenKey(winreg.HKEY_LOCAL_MACHINE, root_path)
            i = 0
            sub = winreg.EnumKey(root, i)
            i += 1
            k = winreg.OpenKey(root, sub)
            dll_path = winreg.QueryValueEx(k, 'FunctionLibrary')[0]
            name = sub
            name = winreg.QueryValueEx(k, 'Name')[0]
            vendor = ''
            vendor = winreg.QueryValueEx(k, 'Vendor')[0]
            if isinstance(dll_path, str):
                dll_path = dll_path.strip().strip('"')
                dll_path = os.path.expandvars(dll_path)
                dll_path = os.path.normpath(dll_path)
            if not dll_path:
                dll_path
            if not name:
                name
            if not vendor:
                vendor
            key = ('', sub, '')
            if key in seen:
                continue
            seen.add(key)
            if not name:
                name
            if not vendor:
                vendor
            if not dll_path:
                dll_path
            if bool(dll_path):
                bool(dll_path)
            devices.append({
                'name': str(sub),
                'vendor': str(''),
                'dll_path': str(''),
                'exists': os.path.isfile(dll_path) })
        return devices
        except Exception:
            return 
        except Exception:
            continue
        except OSError:
            continue
        except Exception:
            continue
        except Exception:
            continue
        except Exception:
            continue
        except Exception:
            continue

    
    class ElmTransport:
        
        def __init__(self):
            self.ser = None
            self._timeout_s = 0.2
            self._write_timeout_s = 0.5

        
        def set_timeouts(self, timeout_s, write_timeout_s = (None, None)):
            pass
        # WARNING: Decompyle incomplete

        
        def close(self):
            
            try:
                if self.ser:
                    self.ser.close()
                self.ser = None
                return None
            except:
                self.ser = None


        
        def open(self = None, port = None, baud = None):
            pass
        # WARNING: Decompyle incomplete

        
        def _drain(self):
            if not self.ser:
                return None
            
            try:
                chunk = self.ser.read(4096)
                if not chunk:
                    return None
                    
                    try:
                        continue
                    except Exception:
                        return None



        
        def _read_until_prompt(self = None, timeout_s = None):
            if not self.ser:
                return ''
            end = time.time() + float(timeout_s)
            buf = bytearray()
            if time.time() < end:
                chunk = self.ser.read(4096)
                if chunk:
                    buf.extend(chunk)
                    if b'>' in buf:
                        pass
                    else:
                        time.sleep(0.01)
                        if time.time() < end:
                            continue
                            
                            try:
                                return buf.decode('ascii', errors = 'ignore')
                            except Exception:
                                return ''


        
        def cmd(self = None, cmd = None, timeout_s = None):
            if not self.ser:
                raise RuntimeError('ELM not connected')
            self.ser.write((cmd.strip() + '\r').encode('ascii', errors = 'ignore'))
            return self._read_until_prompt(timeout_s)

        
        def _init_adapter(self):
            self.cmd('ATZ', 1.6)
            self.cmd('ATE0', 1)
            self.cmd('ATL0', 1)
            self.cmd('ATS1', 1)
            self.cmd('ATH1', 1)
            self.cmd('ATCAF1', 1)
            self.cmd('ATCFC1', 1)
            self.cmd('ATAL', 1)
            self.cmd('ATAT1', 1)

        
        def set_bus(self = None, bus = None, is_29bit = None):
            if not bus:
                bus
            bus = ''.lower().strip()
            if bus == 'hs':
                if bool(is_29bit):
                    r = self.cmd('ATSP7', 1)
                    if '?' in r:
                        r2 = self.cmd('ATSPB', 1)
                        if '?' in r2:
                            raise RuntimeError('Adapter does not support CAN 29-bit ISO-TP protocol (ATSP7)')
                        r = self.cmd('STP 33', 1)
                        if '?' in r:
                            self.cmd('ATSP6', 1)
                            return None
                        return None
                        return None
                return None
            if bus == 'ms':
                r = self.cmd('STP 53', 1)
                if '?' in r:
                    raise RuntimeError('Adapter does not support MS CAN preset (need STN/vLinker)')
                return None
            raise RuntimeError('Unknown bus: ' + str(bus))

        
        def set_header(self = None, tx_id = None, rx_id = None):
            tx_id = int(tx_id)
            rx_id = int(rx_id)
            if tx_id > 2047 or rx_id > 2047:
                self.cmd('ATSH ' + format(tx_id & 536870911, '08X'), 1)
                self.cmd('ATCRA ' + format(rx_id & 536870911, '08X'), 1)
                return None
            self.cmd('ATSH ' + format(tx_id & 2047, '03X'), 1)
            self.cmd('ATCRA ' + format(rx_id & 2047, '03X'), 1)

        
        def request(self = None, tx_id = None, rx_id = None, payload_bytes = (2,), timeout_s = ('tx_id', int, 'rx_id', int, 'timeout_s', float)):
            self.set_header(tx_id, rx_id)
            msg = (lambda .0: pass# WARNING: Decompyle incomplete
)(payload_bytes())
            s = self.cmd(msg, timeout_s)
            return _hex_bytes_from_elm_text(s)


    
    class J2534Transport:
        TXFLAG_CAN_29BIT_ID = 256
        
        def __init__(self):
            self._dll_path = None
            self._dll = None
            self._device_id = None
            self._channel_id = None
            self._protocol = 6
            self._bus = None
            self._filter_ids = []
            self._is_29bit = False
            self._last_tx = None
            self._last_rx = None

        
        def _require_windows(self):
            if sys.platform != 'win32':
                raise RuntimeError('J2534 is supported only on Windows')

        
        def open(self = None, dll_path = None):
            self._require_windows()
            if not dll_path:
                dll_path
            dll_path = ''.strip().strip('"')
            if not dll_path:
                raise RuntimeError('dll_path required')
            dll_path = os.path.expandvars(dll_path)
            if not os.path.exists(dll_path):
                raise RuntimeError('DLL not found: ' + dll_path)
            self.close()
            self._dll_path = dll_path
            self._dll = ctypes.WinDLL(dll_path)
            
            class PASSTHRU_MSG(ctypes.Structure):
                _fields_ = [
                    ('ProtocolID', ctypes.c_uint32),
                    ('RxStatus', ctypes.c_uint32),
                    ('TxFlags', ctypes.c_uint32),
                    ('Timestamp', ctypes.c_uint32),
                    ('DataSize', ctypes.c_uint32),
                    ('ExtraDataIndex', ctypes.c_uint32),
                    ('Data', ctypes.c_ubyte * 4128)]

            self.PASSTHRU_MSG = PASSTHRU_MSG
            self._dll.PassThruOpen.argtypes = [
                ctypes.c_void_p,
                ctypes.POINTER(ctypes.c_uint32)]
            self._dll.PassThruOpen.restype = ctypes.c_int32
            self._dll.PassThruClose.argtypes = [
                ctypes.c_uint32]
            self._dll.PassThruClose.restype = ctypes.c_int32
            self._dll.PassThruConnect.argtypes = [
                ctypes.c_uint32,
                ctypes.c_uint32,
                ctypes.c_uint32,
                ctypes.c_uint32,
                ctypes.POINTER(ctypes.c_uint32)]
            self._dll.PassThruConnect.restype = ctypes.c_int32
            self._dll.PassThruDisconnect.argtypes = [
                ctypes.c_uint32]
            self._dll.PassThruDisconnect.restype = ctypes.c_int32
            self._dll.PassThruStartMsgFilter.argtypes = [
                ctypes.c_uint32,
                ctypes.c_uint32,
                ctypes.POINTER(PASSTHRU_MSG),
                ctypes.POINTER(PASSTHRU_MSG),
                ctypes.POINTER(PASSTHRU_MSG),
                ctypes.POINTER(ctypes.c_uint32)]
            self._dll.PassThruStartMsgFilter.restype = ctypes.c_int32
            self._dll.PassThruStopMsgFilter.argtypes = [
                ctypes.c_uint32,
                ctypes.c_uint32]
            self._dll.PassThruStopMsgFilter.restype = ctypes.c_int32
            self._dll.PassThruWriteMsgs.argtypes = [
                ctypes.c_uint32,
                ctypes.POINTER(PASSTHRU_MSG),
                ctypes.POINTER(ctypes.c_uint32),
                ctypes.c_uint32]
            self._dll.PassThruWriteMsgs.restype = ctypes.c_int32
            self._dll.PassThruReadMsgs.argtypes = [
                ctypes.c_uint32,
                ctypes.POINTER(PASSTHRU_MSG),
                ctypes.POINTER(ctypes.c_uint32),
                ctypes.c_uint32]
            self._dll.PassThruReadMsgs.restype = ctypes.c_int32
            self._dll.PassThruGetLastError.argtypes = [
                ctypes.c_char_p]
            self._dll.PassThruGetLastError.restype = ctypes.c_int32
            self._dll.PassThruIoctl.argtypes = [
                ctypes.c_uint32,
                ctypes.c_uint32,
                ctypes.c_void_p,
                ctypes.c_void_p]
            self._dll.PassThruIoctl.restype = ctypes.c_int32
            dev_id = ctypes.c_uint32(0)
            rc = self._dll.PassThruOpen(None, ctypes.byref(dev_id))
            if rc != 0:
                raise RuntimeError('PassThruOpen failed: ' + self._last_error(rc))
            self._device_id = int(dev_id.value)

        
        def _last_error(self, rc = (None,)):
            pass
        # WARNING: Decompyle incomplete

        
        def _ioctl(self = None, code = None):
            pass
        # WARNING: Decompyle incomplete

        
        def _make_msg(self = None, can_id = None, payload_bytes = None, tx_flags = (0,)):
            msg = self.PASSTHRU_MSG()
            msg.ProtocolID = self._protocol
            msg.RxStatus = 0
            msg.TxFlags = tx_flags
            msg.Timestamp = 0
            msg.ExtraDataIndex = 0
            data = bytearray()
            data += int(can_id).to_bytes(4, 'big', signed = False)
            bytes += (lambda .0: pass# WARNING: Decompyle incomplete
)(payload_bytes())
            msg.DataSize = len(data)
            for i, b in enumerate(data):
                msg.Data[i] = b
            return msg

        
        def _clear_filters(self):
            pass
        # WARNING: Decompyle incomplete

        
        def set_bus(self = None, bus = None, is_29bit = None):
            self._require_windows()
        # WARNING: Decompyle incomplete

        
        def set_ids(self = None, tx_id = None, rx_id = None):
            pass
        # WARNING: Decompyle incomplete

        
        def close(self):
            pass
        # WARNING: Decompyle incomplete

        
        def request(self, bus = None, tx_id = None, rx_id = None, payload_bytes = (2,), timeout_s = ('bus', str, 'tx_id', int, 'rx_id', int, 'timeout_s', float)):
            if not int(tx_id) > 2047:
                int(tx_id) > 2047
            is_29bit = int(rx_id) > 2047
            self.set_bus(bus, is_29bit = is_29bit)
            self.set_ids(tx_id, rx_id)
            txf = self.TXFLAG_CAN_29BIT_ID if is_29bit else 0
        # WARNING: Decompyle incomplete


    
    class OBDManager:
        
        def __init__(self):
            self._mode = None
            self.elm = ElmTransport()
            self.j2534 = J2534Transport()
            self._log = []
            self._log_max = 2500
            self._vin_by_body = { }
            self._timing = {
                'interface_timeout_ms': 100,
                'kwp2000_interbyte_ms': 2,
                'kw71_interbyte_ms': 2,
                'between_requests_ms': 100,
                'response_request_ms': 50,
                'kw2000_init_time_ms': 40,
                'can_inter_frame_ms': 10 }
            self._last_done = 0

        
        def _ts(self):
            t = time.time()
            ms = int((t - int(t)) * 1000)
            return time.strftime('%H:%M:%S', time.localtime(t)) + '.%03d' % ms

        
        def _push_log(self = None, item = None):
            self._log.append(item)
            if len(self._log) > self._log_max:
                self._log = self._log[-(self._log_max):]
                return None

        
        def log_note(self = None, msg = None, body = None, ecu = ('', '')):
            if not body:
                body
            if not ecu:
                ecu
            if not msg:
                msg
            self._push_log({
                't': self._ts(),
                'dir': 'NOTE',
                'body': '',
                'ecu': '',
                'can_id': '',
                'tester': '',
                'data': '',
                'extra': '' })

        
        def log_frame(self, direction, body, ecu = None, can_id = None, payload_bytes = None, tester_byte = ('',), extra = ('direction', str, 'body', str, 'ecu', str, 'can_id', int, 'tester_byte', int, 'extra', str)):
            tb = ''
        # WARNING: Decompyle incomplete

        
        def get_log(self):
            return list(self._log)

        
        def clear_log(self):
            self._log = []

        
        def get_timing(self):
            
            try:
                return dict(self._timing)
            except Exception:
                return 


        
        def set_timing(self = None, timing = None):
            if not isinstance(timing, dict):
                return self.get_timing()
            
            try:
                for k in list(self._timing.keys()):
                    if not k in timing:
                        continue
                    v = int(float(timing.get(k)))
                    
                    try:
                        if v < 0:
                            v = 0
                        if v > 60000:
                            v = 60000
                        self._timing[k] = v
                        continue
                        
                        try:
                            self.elm.set_timeouts(timeout_s = float(self._timing.get('interface_timeout_ms', 100)) / 1000)
                            return self.get_timing()
                            except Exception:
                                
                                try:
                                    continue
                                    
                                    try:
                                        pass
                                    except Exception:
                                        continue
                                        except Exception:
                                            return self.get_timing()






        
        def list_ports(self):
            pass
        # WARNING: Decompyle incomplete

        
        def connect_elm(self = None, port = None, baud = None):
            self.disconnect()
            self.elm.open(port, baud)
            
            try:
                self.elm.set_timeouts(timeout_s = float(self._timing.get('interface_timeout_ms', 100)) / 1000)
                self._last_done = 0
                self._mode = 'elm'
                self.log_note(f'''ELM connected: {port} @ {baud}''')
                return None
            except Exception:
                continue


        
        def connect_j2534(self = None, dll_path = None):
            self.disconnect()
            self.j2534.open(dll_path)
            self._mode = 'j2534'
            self.log_note(f'''J2534 connected: {dll_path}''')

        
        def disconnect(self):
            
            try:
                self.elm.close()
                
                try:
                    self.j2534.close()
                    self._mode = None
                    self.log_note('OBD disconnected')
                    return None
                    except Exception:
                        continue
                except Exception:
                    continue



        
        def _body_cfg(self = None, body = None):
            if not body:
                body
            body = ''.strip()
            if not body:
                return None
            mp = load_obd_ecu_map(force = False)
            if not mp or isinstance(mp, dict):
                return None
            bodies = mp.get('bodies')
            if not isinstance(bodies, dict):
                return None
            return bodies.get(body)

        
        def _resolve_ecu(self = None, body_cfg = None, key = None):
            if not body_cfg or isinstance(body_cfg, dict):
                return None
            ecus = body_cfg.get('ecus')
            if not isinstance(ecus, dict):
                return None
            if not key:
                key
            k = ''.strip()
            if not k:
                return None
            if k in ecus:
                return (k, ecus.get(k))
            for name, ent in None.items():
                if not isinstance(ent, dict):
                    continue
                als = ent.get('aliases')
                if not isinstance(als, list):
                    continue
                if not k in als:
                    continue
                
                return None.items(), (name, ent)

        
        def _target_from_ecu(self = None, ent = None):
            if not ent:
                ent
            t = { }.get('target')
        # WARNING: Decompyle incomplete

        
        def _bus_from_body(self = None, body_cfg = None, fallback = None):
            if not body_cfg:
                body_cfg
            b = { }.get('bus')
            return _to_bus(b, fallback)

        
        def _bus_for_ecu(self = None, body_cfg = None, ecu_ent = None, fallback = ('hs',)):
            
            try:
                if not ecu_ent:
                    ecu_ent
                b = { }.get('bus')
                if b:
                    return _to_bus(b, fallback)
                return None._bus_from_body(body_cfg, fallback)
            except Exception:
                b = None
                continue


        
        def _ids_29bit(self = None, target = None, tester = None):
            target = int(target) & 255
            tester = int(tester) & 255
            tx = 416940032 | target << 8 | tester
            rx = 416940032 | tester << 8 | target
            return (tx, rx)

        
        def _request_raw(self, bus, body, ecu, tx = None, rx = None, payload = None, timeout_s = (None,), tester_byte = ('bus', str, 'body', str, 'ecu', str, 'tx', int, 'rx', int, 'timeout_s', float, 'tester_byte', int)):
            if not int(tx) > 2047:
                int(tx) > 2047
            is_29bit = int(rx) > 2047
            
            try:
                bt = int(self._timing.get('between_requests_ms', 0))
                if bt > 0 and self._last_done:
                    dt = bt / 1000 - time.monotonic() - self._last_done
                    if dt > 0:
                        time.sleep(dt)
                if not bus:
                    bus
                self.log_frame('TX', body, ecu, tx, payload, tester_byte, extra = '')
                if self._mode == 'j2534':
                    resp = self.j2534.request(bus, tx, rx, payload, timeout_s)
                elif self._mode == 'elm':
                    self.elm.set_bus(bus, is_29bit = is_29bit)
                    resp = self.elm.request(tx, rx, payload, timeout_s)
                else:
                    raise RuntimeError('Not connected')
                if resp:
                    if not bus:
                        bus
                    self.log_frame('RX', body, ecu, rx, resp, tester_byte, extra = '')
                elif not bus:
                    bus
                self.log_frame('RX', body, ecu, rx, [], tester_byte, extra = '' + ' timeout')
                
                try:
                    self._last_done = time.monotonic()
                    rr = int(self._timing.get('response_request_ms', 0))
                    if rr > 0:
                        time.sleep(rr / 1000)
                    if resp and is_29bit:
                        
                        try:
                            exp = rx if self._mode == 'elm' else None
                            norm = _elm_extract_isotp_payload(resp, expected_can_id = exp)
                            if norm:
                                return norm
                            return resp
                            return resp
                            except Exception:
                                continue
                            except Exception:
                                continue
                        except Exception:
                            return resp




        
        def read_vin(self = None, bus_mode = None, body = None):
            '''Reads VIN from BCM (Target 0x40) on HS CAN (Strict).'''
            bus = 'hs'
            target = 64
            testers = [
                242,
                241]
        # WARNING: Decompyle incomplete

        
        def read_proxi_bcm(self = None, bus_mode = None, ids = None, body = ('',)):
            '''
        Reads PROXI (DID 2023) from BCM using 29-bit CAN.
        Enforces: HS CAN, Tester F2 -> F1 fallback, UDS 10 03 -> 22 20 23.
        '''
            target = 64
            bus = 'hs'
            testers = [
                242,
                241]
            last_error = 'Unknown error'
            for tester in testers:
                (tx, rx) = self._ids_29bit(target, tester)
                session_payload = [
                    16,
                    3]
                s_resp = self._request_raw(bus, body, 'BCM', tx, rx, session_payload, 2, tester_byte = tester)
                if s_resp and len(s_resp) < 2 or s_resp[0] != 80:
                    last_error = f'''Tester {tester:02X}: Session 10 03 failed/refused'''
                    continue
                read_payload = [
                    34,
                    32,
                    35]
                r_resp = self._request_raw(bus, body, 'BCM', tx, rx, read_payload, 8, tester_byte = tester)
                if r_resp and len(r_resp) >= 3 and r_resp[0] == 127 and r_resp[2] == 120:
                    self.log_note(f'''Tester {tester:02X}: Response Pending, waiting...''', body = body)
                    time.sleep(1.5)
                    r_resp = self._request_raw(bus, body, 'BCM', tx, rx, read_payload, 8, tester_byte = tester)
                if r_resp and len(r_resp) >= 3 and r_resp[0] == 98 and r_resp[1] == 32 and r_resp[2] == 35:
                    self.log_note(f'''BCM Read OK using tester 0x{tester:02X}''', body = body)
                    
                    return testers, ('', bytes(r_resp[3:]))
            raise RuntimeError(f'''BCM Read Failed: {last_error}''')
            except Exception:
                None = None
                last_error = f'''Tester {tester:02X}: Exception {str(e)}'''
                e = None
                del e
                continue
                e = None
                del e

        
        def check_write_access(self = None, bus_mode = None, ids = None, body = ('',)):
            bus = 'hs'
            target = 64
            tester = 242
            (tx, rx) = self._ids_29bit(target, tester)
            
            try:
                s_resp = self._request_raw(bus, body, 'BCM', tx, rx, [
                    16,
                    3], 2, tester_byte = tester)
                if s_resp or s_resp[0] != 80:
                    return (False, 'No response')
                    
                    try:
                        r = self._request_raw(bus, body, 'BCM', tx, rx, [
                            46,
                            32,
                            35], 2, tester_byte = tester)
                        if len(r) >= 3 and r[0] == 127 and r[1] == 46:
                            return (True, 'Negative response returned (gateway passes traffic)')
                            
                            try:
                                if len(r) >= 3 and r[0] == 110 and r[1] == 32 and r[2] == 35:
                                    return (True, 'Positive response returned')
                                    
                                    try:
                                        if not r:
                                            return (False, 'No response')
                                        return (True, 'Response returned')
                                    except Exception:
                                        e = None
                                        del e
                                        return None
                                        None = 
                                        del e





        
        def write_proxi(self, targets, data_bytes = None, bus_mode = None, auto_detect_radio_stack = None, ids = ('',), body = ('bus_mode', str, 'auto_detect_radio_stack', bool, 'ids', dict, 'body', str)):
            if not data_bytes:
                data_bytes
            data_bytes = (lambda .0: pass# WARNING: Decompyle incomplete
)([]())
            results = { }
            target_map = {
                'BCM': 64,
                'IPC': 96,
                'ETM': 135,
                'RADIO': 135,
                'RADIO_STACK': 135,
                'CTM': 135 }
            if not targets:
                targets
            for t_name in []:
                name_up = t_name.upper()
                target = target_map.get(name_up, 64)
                bus = 'hs'
                if name_up in ('ETM', 'RADIO', 'RADIO_STACK', 'CTM', 'AMP'):
                    bus = 'ms'
                success = False
                err_msg = ''
                testers = [
                    242,
                    241]
                for tester in testers:
                    (tx, rx) = self._ids_29bit(target, tester)
                    sess_resp = self._request_raw(bus, body, t_name, tx, rx, [
                        16,
                        3], 2, tester_byte = tester)
                    if sess_resp or sess_resp[0] != 80:
                        err_msg = 'Session failed'
                        continue
                    write_payload = [
                        46,
                        32,
                        35] + list(data_bytes)
                    w_resp = self._request_raw(bus, body, t_name, tx, rx, write_payload, 6, tester_byte = tester)
                    if w_resp and w_resp[0] == 110:
                        success = True
                        testers
                    elif w_resp and w_resp[0] == 127 and w_resp[2] == 120:
                        pass
                    err_msg = 'Write failed/rejected'
            continue
            return results
            except Exception:
                e = None
                results[t_name] = {
                    'ok': False,
                    'err': str(e),
                    'ecu': t_name,
                    'bus': bus }
                e = None
                del e
                continue
                e = None
                del e


    _OBD = OBDManager()
    
    def _msgbox(title = None, text = None):
        
        try:
            ctypes.windll.user32.MessageBoxW(0, text, title, 0)
            return None
        except Exception:
            return None


    
    def _start_webview():
        
        try:
            import webview.platforms.edgechromium as webview
            webview.start(gui = 'edgechromium')
            return None
        except Exception:
            e = None
            title = globals().get('APP_NAME', 'App')
            _msgbox(title, f'''Web UI backend missing.\n\nНужен WebView2 Runtime И pythonnet (модуль \'clr\').\nЕсли у тебя уже стоит WebView2, но пишет про \'clr\' — этот билд собран без pythonnet/или на Python 3.14, где pythonnet часто не живёт.\nРешение: пересобрать на Python 3.13 x64 с установленным pythonnet.\n\nDetails: {e!r}''')
            raise 
            e = None
            del e


    from cryptography.hazmat.primitives import hashes, serialization
    from cryptography.hazmat.primitives.asymmetric import padding
    from cryptography.exceptions import InvalidSignature
    from cryptography.hazmat.primitives.ciphers.aead import AESGCM
    from cryptography.hazmat.primitives.kdf.hkdf import HKDF
    APP_NAME = 'FCA PROXI Tool'
    APP_VERSION = '1.2.0.1'
    DATA_DIR = os.path.join(os.environ.get('APPDATA', os.path.expanduser('~')), APP_NAME)
    os.makedirs(DATA_DIR, exist_ok = True)
    DEVICE_SEED_PATH = os.path.join(DATA_DIR, 'device_seed.dpapi')
    LICENSE_PATH = os.path.join(DATA_DIR, 'license.json')
    VENDOR_PUB_SPKI_B64 = 'MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEA1+q2g7QZcfKu6lTGuOD55QtHMeKd0KZVuFQ9bsSf4j7hFp24jKHJKbQBemEuhKd2ALK+kCLlNFGgC1x11FX5BVAgpusnRPOMZVHDVahbPpI15nEcr4efaTDXQHG6OMtHKJPdw//MOukkBaDBeNdsTm4qjT/61hxTeXbX79JCwjFy2zrKrGHSV0KzRK8DI5I1qT4NIm5PjtmnTDRE8PssdXuWt5+gVrt4+mywdzELSnygOGFBO5Eh0g82YdtRSLqkNipeB/dKIFNQdTNOTguLZLC3oytNGE9SEQ0nOuyp/2AbFXb/BTYWfVvg6pDfRmF2qSmbCSRsnawlhTjryxXYEwIDAQAB'
    ASSET_SALT_B64 = '5YYFwyJK2oqNb8B5SJLG9g=='
    VM_HARD_MARKERS = ('vmware', 'virtualbox', 'vbox', 'qemu', 'kvm', 'xen', 'parallels', 'bochs', 'virtual machine', 'innotek gmbh')
    VM_DISK_MARKERS = ('vbox', 'vmware', 'qemu', 'virtual', 'virtio')
    VM_PROC_MARKERS = ('vmtoolsd.exe', 'vmwaretray.exe', 'vmwareuser.exe', 'vboxservice.exe', 'vboxtray.exe', 'qemu-ga.exe')
    
    def _ps(cmd = None):
        
        try:
            p = subprocess.run([
                'powershell',
                '-NoProfile',
                '-ExecutionPolicy',
                'Bypass',
                '-Command',
                cmd], capture_output = True, text = True, timeout = 4)
            if not p.stdout:
                p.stdout
            return ''
        except Exception:
            return ''


    
    def _tasklist():
        
        try:
            p = subprocess.run([
                'tasklist'], capture_output = True, text = True, timeout = 3)
            if not p.stdout:
                p.stdout
            return ''
        except Exception:
            return ''


    
    def is_virtual_machine_hard():
        pass
    # WARNING: Decompyle incomplete

    
    class DATA_BLOB(ctypes.Structure):
        _fields_ = [
            ('cbData', wintypes.DWORD),
            ('pbData', ctypes.POINTER(ctypes.c_byte))]

    crypt32 = ctypes.WinDLL('crypt32', use_last_error = True)
    kernel32 = ctypes.WinDLL('kernel32', use_last_error = True)
    CryptProtectData = crypt32.CryptProtectData
    CryptProtectData.argtypes = [
        ctypes.POINTER(DATA_BLOB),
        wintypes.LPCWSTR,
        ctypes.c_void_p,
        ctypes.c_void_p,
        ctypes.c_void_p,
        wintypes.DWORD,
        ctypes.POINTER(DATA_BLOB)]
    CryptProtectData.restype = wintypes.BOOL
    CryptUnprotectData = crypt32.CryptUnprotectData
    CryptUnprotectData.argtypes = [
        ctypes.POINTER(DATA_BLOB),
        ctypes.POINTER(wintypes.LPWSTR),
        ctypes.c_void_p,
        ctypes.c_void_p,
        ctypes.c_void_p,
        wintypes.DWORD,
        ctypes.POINTER(DATA_BLOB)]
    CryptUnprotectData.restype = wintypes.BOOL
    LocalFree = kernel32.LocalFree
    LocalFree.argtypes = [
        ctypes.c_void_p]
    LocalFree.restype = ctypes.c_void_p
    
    def _blob_from_bytes(b = None):
        buf = (ctypes.c_byte * len(b)).from_buffer_copy(b)
        return DATA_BLOB(len(b), ctypes.cast(buf, ctypes.POINTER(ctypes.c_byte)))

    
    def dpapi_encrypt(plain = None):
        in_blob = _blob_from_bytes(plain)
        out_blob = DATA_BLOB()
        ok = CryptProtectData(ctypes.byref(in_blob), None, None, None, None, 0, ctypes.byref(out_blob))
        if not ok:
            raise OSError(ctypes.get_last_error())
        
        try:
            LocalFree(out_blob.pbData)
            return ctypes.string_at(out_blob.pbData, out_blob.cbData)
        except:
            LocalFree(out_blob.pbData)


    
    def dpapi_decrypt(cipher = None):
        in_blob = _blob_from_bytes(cipher)
        out_blob = DATA_BLOB()
        desc = wintypes.LPWSTR()
        ok = CryptUnprotectData(ctypes.byref(in_blob), ctypes.byref(desc), None, None, None, 0, ctypes.byref(out_blob))
        if not ok:
            raise OSError(ctypes.get_last_error())
        
        try:
            if desc:
                LocalFree(desc)
            LocalFree(out_blob.pbData)
            return ctypes.string_at(out_blob.pbData, out_blob.cbData)
        except:
            if desc:
                LocalFree(desc)
            LocalFree(out_blob.pbData)


    
    def load_or_create_device_seed():
        if os.path.isfile(DEVICE_SEED_PATH):
            f = open(DEVICE_SEED_PATH, 'rb')
            enc = f.read()
            None(None, None)
            return dpapi_decrypt(enc)
        seed = None.urandom(32)
        enc = dpapi_encrypt(seed)
        f = open(DEVICE_SEED_PATH, 'wb')
        f.write(enc)
        None(None, None)
        return seed
        with None:
            if not None:
                pass
    # WARNING: Decompyle incomplete

    
    def get_request_code():
        seed = load_or_create_device_seed()
        h = hashlib.sha256(seed).hexdigest().upper()
        return h[:40]

    
    def canonical_json(obj = None):
        return json.dumps(obj, sort_keys = True, separators = (',', ':'), ensure_ascii = False).encode('utf-8')

    
    def load_vendor_public_key():
        if VENDOR_PUB_SPKI_B64 or 'REPLACE_ME' in VENDOR_PUB_SPKI_B64:
            return None
        der = base64.b64decode(VENDOR_PUB_SPKI_B64)
        return serialization.load_der_public_key(der)

    
    def read_license_obj():
        if not os.path.isfile(LICENSE_PATH):
            return None
        
        try:
            f = open(LICENSE_PATH, 'r', encoding = 'utf-8')
            
            try:
                None(None, None)
                return 
                with None:
                    if not None, json.load(f):
                        pass
                
                try:
                    return None
                    
                    try:
                        pass
                    except Exception:
                        return None





    
    def write_license_obj(obj = None):
        f = open(LICENSE_PATH, 'w', encoding = 'utf-8')
        json.dump(obj, f, ensure_ascii = False, indent = 2)
        None(None, None)
        return None
        with None:
            if not None:
                pass

    
    def verify_license(lic = None):
        return (True, 'ok')
        for k in ('v', 'product', 'request', 'edition', 'features', 'sig'):
            if not k not in lic:
                continue
            
            return ('v', 'product', 'request', 'edition', 'features', 'sig'), (False, f'''missing_{k}''')
        if lic['product'] != APP_NAME:
            return (False, 'wrong_product')
        if not lic['request']:
            lic['request']
        if ''.strip().upper() != get_request_code():
            return (False, 'wrong_request')
    # WARNING: Decompyle incomplete

    
    try:
        from assets_store import ASSETS_ENC
        
        def _hkdf_asset_key():
            pub_der = base64.b64decode(VENDOR_PUB_SPKI_B64)
            salt = base64.b64decode(ASSET_SALT_B64)
            ikm = hashlib.sha256(pub_der).digest()
            kdf = HKDF(algorithm = hashes.SHA256(), length = 32, salt = salt, info = b'ASSET-KEY-v1')
            return kdf.derive(ikm)

        
        def _decrypt_asset(path = None):
            blob_b64 = ASSETS_ENC.get(path)
            if not blob_b64:
                raise KeyError(path)
            blob = base64.b64decode(blob_b64)
            nonce = blob[:12]
            ct = blob[12:]
            aes = AESGCM(_hkdf_asset_key())
            return aes.decrypt(nonce, ct, path.encode('utf-8'))

        
        def guess_mime(path = None):
            p = path.lower()
            if p.endswith('.html'):
                return 'text/html; charset=utf-8'
            if p.endswith('.js'):
                return 'application/javascript; charset=utf-8'
            if p.endswith('.css'):
                return 'text/css; charset=utf-8'
            if p.endswith('.json'):
                return 'application/json; charset=utf-8'
            if p.endswith('.png'):
                return 'image/png'
            if p.endswith('.jpg') or p.endswith('.jpeg'):
                return 'image/jpeg'
            if p.endswith('.svg'):
                return 'image/svg+xml'
            return 'application/octet-stream'

        
        class AssetHandler(http.server.BaseHTTPRequestHandler):
            
            def do_GET(self):
                path = self.path.split('?', 1)[0].split('#', 1)[0]
                if path == '/' or path == '':
                    path = '/app.html'
                if path.startswith('/'):
                    path = path[1:]
            # WARNING: Decompyle incomplete

            
            def log_message(self, format, *args):
                pass


        
        def start_asset_server():
            httpd = socketserver.TCPServer(('127.0.0.1', 0), AssetHandler)
            port = httpd.server_address[1]
            t = threading.Thread(target = httpd.serve_forever, daemon = True)
            t.start()
            return (httpd, port)

        _HTTPD = None
        _HTTPD_PORT = None
        
        def ensure_asset_server():
            pass
        # WARNING: Decompyle incomplete

        
        def activation_html():
            return f'''\n<!doctype html>\n<html>\n<head>\n<meta charset="utf-8">\n<meta name="viewport" content="width=device-width, initial-scale=1">\n<title>Activation</title>\n<style>\nbody{{font-family:Arial,sans-serif;background:#0b0b0b;color:#eee;margin:0;padding:24px;}}\n.card{{max-width:860px;margin:0 auto;background:#141414;border:1px solid #2a2a2a;border-radius:12px;padding:18px;}}\nh1{{margin:0 0 12px 0;font-size:18px;}}\n.row{{margin:10px 0;}}\nbutton{{padding:10px 14px;border:0;border-radius:10px;background:#2b6cff;color:white;font-weight:700;cursor:pointer;}}\n.small{{color:#aaa;font-size:12px;word-break:break-all;}}\n.ok{{color:#7CFF7C;font-weight:700;}}\n.bad{{color:#FF7C7C;font-weight:700;}}\n.mini{{padding:6px 10px;border-radius:8px;font-weight:700;font-size:12px;background:#1f1f1f;border:1px solid #2a2a2a;color:#eee;cursor:pointer;}}\n.mini:hover{{border-color:#3a3a3a;}}\n.mini:disabled{{opacity:0.5;cursor:not-allowed;}}\n.hrow{{display:flex;align-items:center;gap:10px;flex-wrap:wrap;}}\n</style>\n</head>\n<body>\n<div class="card">\n  <h1>{APP_NAME} Activation</h1>\n\n  <div class="row small hrow">\n    Request Code: <code id="req"></code>\n    <button class="mini" onclick="copyReq()">Copy</button>\n  </div>\n\n  <div class="row small">Select license.json file:</div>\n  <div class="row hrow">\n    <button class="mini" onclick="loadLicense()">Choose license.json…</button>\n    <span class="small" id="licfile"></span>\n  </div>\n\n  <div class="row hrow">\n    <button id="act" class="mini" onclick="activateLoaded()" disabled>Activate</button>\n    <span class="small" id="status"></span>\n  </div>\n</div>\n\n<script>\nasync function init(){{\n  try {{\n    document.getElementById(\'req\').textContent = await window.pywebview.api.get_request_code();\n    const st = await window.pywebview.api.check_license();\n    if(st && st.ok) {{\n      document.getElementById(\'status\').innerHTML = "<span class=\'ok\'>Already activated.</span>";\n      document.getElementById(\'act\').disabled = true;\n    }}\n  }} catch(e) {{\n    document.getElementById(\'status\').innerHTML = "<span class=\'bad\'>Init failed: " + (e && (e.message || e.toString()) ? (e.message || e.toString()) : \'unknown\') + "</span>";\n  }}\n}}\n\nasync function copyReq(){{\n  const t = (document.getElementById(\'req\').textContent || \'\').trim();\n  const st = document.getElementById(\'status\');\n  if(!t){{ st.innerHTML = "<span class=\'bad\'>Request code is empty.</span>"; return; }}\n  const r = await window.pywebview.api.copy_text(t);\n  if(r && r.ok) st.innerHTML = "<span class=\'ok\'>Copied.</span>";\n  else st.innerHTML = "<span class=\'bad\'>Copy failed: " + ((r && r.err) ? r.err : \'\') + "</span>";\n}}\n\nasync function loadLicense(){{\n  const st = document.getElementById(\'status\');\n  const r = await window.pywebview.api.pick_license_file();\n  if(r && r.ok){{\n    document.getElementById(\'licfile\').textContent = r.name ? ("Loaded: " + r.name) : "Loaded.";\n    document.getElementById(\'act\').disabled = false;\n    st.innerHTML = "<span class=\'ok\'>License loaded.</span>";\n  }} else if(r && r.err && r.err !== "cancel"){{\n    st.innerHTML = "<span class=\'bad\'>Load failed: " + r.err + "</span>";\n  }}\n}}\n\nasync function activateLoaded(){{\n  const st = document.getElementById(\'status\');\n  const r = await window.pywebview.api.activate_loaded();\n  if(r && r.ok){{\n    st.innerHTML = "<span class=\'ok\'>Activated.</span>";\n    document.getElementById(\'act\').disabled = true;\n  }} else {{\n    st.innerHTML = "<span class=\'bad\'>Activate failed: " + (r && r.err ? r.err : "unknown") + "</span>";\n  }}\n}}\n\nfunction boot(){{\n  const st = document.getElementById(\'status\');\n  if(st) st.innerHTML = "<span class=\'small\'>Waiting for backend…</span>";\n  const run = () => init();\n  if(window.pywebview && window.pywebview.api){{ run(); return; }}\n  window.addEventListener(\'pywebviewready\', run, {{once:true}});\n  // fallback in case event is missed\n  setTimeout(() => {{ if(window.pywebview && window.pywebview.api) run(); }}, 150);\n}}\nboot();\n</script>\n</body>\n</html>\n'''

        
        class Api:
            
            def __init__(self):
                self._obd = _OBD
                self._loaded_license_raw = None
                self._loaded_license_name = None

            
            def get_request_code(self):
                return get_request_code()

            
            def obd_list_serial_ports(self):
                
                try:
                    return {
                        'ok': True,
                        'ports': self._obd.list_ports() }
                except Exception:
                    e = None
                    del e
                    return None
                    None = 
                    del e


            
            def obd_list_j2534_devices(self):
                
                try:
                    return {
                        'ok': True,
                        'devices': list_j2534_devices() }
                except Exception:
                    e = None
                    del e
                    return None
                    None = 
                    del e


            
            def obd_elm_connect(self = None, cfg = None):
                
                try:
                    if not cfg:
                        cfg
                    timing = { }.get('timing', None)
                    if isinstance(timing, dict):
                        
                        try:
                            self._obd.set_timing(timing)
                            
                            try:
                                if not cfg:
                                    cfg
                                port = { }.get('port', '')
                                if not cfg:
                                    cfg
                                baud = int({ }.get('baud', 115200))
                                if not port:
                                    return {
                                        'ok': False,
                                        'err': 'port required' }
                                None._obd.connect_elm(port, baud)
                                return {
                                    'ok': True }
                                except Exception:
                                    
                                    try:
                                        continue
                                        
                                        try:
                                            pass
                                        except Exception:
                                            e = None
                                            del e
                                            return None
                                            None = 
                                            del e






            
            def obd_j2534_connect(self = None, cfg = None):
                
                try:
                    if not cfg:
                        cfg
                    dll_path = { }.get('dll_path', '')
                    if not dll_path:
                        return {
                            'ok': False,
                            'err': 'dll_path required' }
                    None._obd.connect_j2534(dll_path)
                    if not cfg:
                        cfg
                    bus_mode = str({ }.get('bus_mode', 'hs')).lower().strip()
                    if bus_mode in ('hs', 'ms'):
                        
                        try:
                            self._obd.j2534.set_bus(bus_mode)
                            
                            try:
                                return {
                                    'ok': True }
                                except Exception:
                                    
                                    try:
                                        continue
                                        
                                        try:
                                            pass
                                        except Exception:
                                            e = None
                                            del e
                                            return None
                                            None = 
                                            del e






            
            def obd_disconnect(self):
                
                try:
                    self._obd.disconnect()
                    return {
                        'ok': True }
                except Exception:
                    e = None
                    del e
                    return None
                    None = 
                    del e


            
            def obd_get_timing(self):
                
                try:
                    return {
                        'ok': True,
                        'timing': self._obd.get_timing() }
                except Exception:
                    e = None
                    del e
                    return None
                    None = 
                    del e


            
            def obd_set_timing(self = None, cfg = None):
                
                try:
                    if not cfg:
                        cfg
                    if not cfg:
                        cfg
                    timing = { }.get('timing', { })
                    t = self._obd.set_timing(timing)
                    return {
                        'ok': True,
                        'timing': t }
                except Exception:
                    e = None
                    del e
                    return None
                    None = 
                    del e


            
            def obd_get_log(self):
                
                try:
                    return {
                        'ok': True,
                        'items': self._obd.get_log() }
                except Exception:
                    e = None
                    del e
                    return None
                    None = 
                    del e


            
            def obd_clear_log(self):
                
                try:
                    self._obd.clear_log()
                    return {
                        'ok': True }
                except Exception:
                    e = None
                    del e
                    return None
                    None = 
                    del e


            
            def obd_read_proxi_bcm(self = None, cfg = None):
                
                try:
                    if not cfg:
                        cfg
                    bus_mode = { }.get('bus_mode', 'auto')
                    if not cfg:
                        cfg
                    ids = { }.get('ids', None)
                    if not cfg:
                        cfg
                    body = { }.get('body', '')
                    (vin, data) = self._obd.read_proxi_bcm(bus_mode, ids, body)
                    return {
                        'ok': True,
                        'vin': vin,
                        'bytes': list(data) }
                except Exception:
                    e = None
                    del e
                    return None
                    None = 
                    del e


            
            def obd_read_vin(self = None, cfg = None):
                
                try:
                    if not cfg:
                        cfg
                    bus_mode = { }.get('bus_mode', 'auto')
                    if not cfg:
                        cfg
                    body = { }.get('body', '')
                    vin = self._obd.read_vin(bus_mode, body)
                    return {
                        'ok': True,
                        'vin': vin }
                except Exception:
                    e = None
                    del e
                    return None
                    None = 
                    del e


            
            def obd_write_proxi(self = None, opts = None):
                
                try:
                    if not opts:
                        opts
                    targets = { }.get('targets', [])
                    if not opts:
                        opts
                    data_bytes = { }.get('bytes', [])
                    if not opts:
                        opts
                    bus_mode = { }.get('bus_mode', 'auto')
                    if not opts:
                        opts
                    auto_detect = bool({ }.get('auto_detect_radio_stack', True))
                    if not opts:
                        opts
                    ids = { }.get('ids', None)
                    if not opts:
                        opts
                    body = { }.get('body', '')
                    if not isinstance(targets, list) or targets:
                        return {
                            'ok': False,
                            'err': 'targets required' }
                    if None(data_bytes, list) or len(data_bytes) < 16:
                        return {
                            'ok': False,
                            'err': 'bytes required' }
                    results = None._obd.write_proxi(targets, data_bytes, bus_mode, auto_detect, ids, body)
                    return {
                        'ok': True,
                        'results': results }
                except Exception:
                    e = None
                    del e
                    return None
                    None = 
                    del e


            
            def obd_check_write_access(self = None, cfg = None):
                
                try:
                    if not cfg:
                        cfg
                    bus_mode = { }.get('bus_mode', 'auto')
                    if not cfg:
                        cfg
                    ids = { }.get('ids', None)
                    if not cfg:
                        cfg
                    body = { }.get('body', '')
                    (allowed, detail) = self._obd.check_write_access(bus_mode, ids, body)
                    return {
                        'ok': True,
                        'write_allowed': allowed,
                        'detail': detail }
                except Exception:
                    e = None
                    del e
                    return None
                    None = 
                    del e


            
            def copy_text(self = None, text = None):
                '''Copy text to Windows clipboard (robust in PyInstaller builds).'''
                pass
            # WARNING: Decompyle incomplete

            
            def pick_license_file(self):
                pass
            # WARNING: Decompyle incomplete

            
            def check_license(self):
                lic = read_license_obj()
                if not lic:
                    return {
                        'ok': False }
                (ok, err) = None(lic)
                return {
                    'ok': ok,
                    'err': err }

            
            def activate_loaded(self):
                if not self._loaded_license_raw:
                    return {
                        'ok': False,
                        'err': 'no_license_loaded' }
                
                try:
                    lic = json.loads(self._loaded_license_raw)
                    (ok, err) = verify_license(lic)
                    if not ok:
                        return {
                            'ok': False,
                            'err': err }
                    
                    try:
                        write_license_obj(lic)
                        self._loaded_license_raw = None
                        if ASSETS_ENC and 'app.html' in ASSETS_ENC and webview.windows:
                            port = ensure_asset_server()
                            url = f'''http://127.0.0.1:{port}/'''
                            
                            try:
                                webview.windows[0].set_title(APP_NAME)
                                
                                try:
                                    webview.windows[0].load_url(url)
                                    return {
                                        'ok': True }
                                    except Exception:
                                        return 
                                    except Exception:
                                        
                                        try:
                                            continue
                                            
                                            try:
                                                pass
                                            except Exception:
                                                del e
                                                return None
                                                None = 
                                                del e








        
        def main():
            if is_virtual_machine_hard():
                webview.create_window('Blocked', html = '<h3>Virtual machine detected. Launch blocked.</h3>')
                _start_webview()
                return None
            api = Api()
            lic = read_license_obj()
            ok = False
            if lic:
                (ok, _) = verify_license(lic)
            if ok:
                if ASSETS_ENC or 'app.html' not in ASSETS_ENC:
                    webview.create_window('Error', html = '<h3>Assets missing. Repack build.</h3>')
                    _start_webview()
                    return None
                (httpd, port) = start_asset_server()
                url = f'''http://127.0.0.1:{port}/'''
                webview.create_window(APP_NAME, url, js_api = api, width = 1200, height = 820)
                _start_webview()
                httpd.shutdown()
                return None
            webview.create_window(f'''{APP_NAME} - Activation''', html = activation_html(), js_api = api, width = 900, height = 620)
            _start_webview()

        if __name__ == '__main__':
            main()
            return None
        return None
        except Exception:
            serial = None
            list_ports = None
            continue
    except Exception:
        ASSETS_ENC = { }
        continue


