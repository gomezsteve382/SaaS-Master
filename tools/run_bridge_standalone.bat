@echo off
REM ============================================================
REM  SRT Lab J2534 Bridge — STANDALONE LAUNCHER
REM  No external dependencies. Writes bridge.py to temp and runs it.
REM  Double-click to start. Keep this window open while using SRT Lab.
REM ============================================================
setlocal EnableDelayedExpansion

set BRIDGE_PORT=8765
set DLL_PATH=
set TMPPY=%TEMP%\srtlab_bridge_%RANDOM%.py

echo ============================================================
echo  SRT Lab J2534 Bridge — Standalone
echo  Port: %BRIDGE_PORT%
echo ============================================================
echo.

REM ---- DLL Auto-Detection ----
REM PRIMARY: TOPDON R-Link / ArtiDiag (confirmed path on this machine)
if exist "C:\Program Files (x86)\TOPDON\ArtiDiagVci\PassThru432.dll" (
    set DLL_PATH=C:\Program Files (x86)\TOPDON\ArtiDiagVci\PassThru432.dll
    echo [FOUND] TOPDON R-Link / ArtiDiag VCI ^(confirmed^)
    goto :write_bridge
)
if exist "C:\Program Files (x86)\TOPDON\RLink\PassThru432.dll" (
    set DLL_PATH=C:\Program Files (x86)\TOPDON\RLink\PassThru432.dll
    echo [FOUND] TOPDON R-Link 32-bit
    goto :write_bridge
)
if exist "C:\Program Files (x86)\TOPDON\ArtiDiagVci\PassThru464.dll" (
    set DLL_PATH=C:\Program Files (x86)\TOPDON\ArtiDiagVci\PassThru464.dll
    echo [FOUND] TOPDON ArtiDiag 64-bit
    goto :write_bridge
)
if exist "C:\Program Files (x86)\TOPDON\RLink\PassThru464.dll" (
    set DLL_PATH=C:\Program Files (x86)\TOPDON\RLink\PassThru464.dll
    echo [FOUND] TOPDON R-Link 64-bit
    goto :write_bridge
)
if exist "C:\Program Files\TOPDON\RLink\PassThru464.dll" (
    set DLL_PATH=C:\Program Files\TOPDON\RLink\PassThru464.dll
    echo [FOUND] TOPDON R-Link 64-bit ^(PF^)
    goto :write_bridge
)
REM SECONDARY: wiTECH Legacy VCI ^(Chrysler/FCA native — excellent for FCA vehicles^)
if exist "C:\Program Files (x86)\DCC Tools\wiTECH\jserver\app\legacyVCI\lvci32.dll" (
    set DLL_PATH=C:\Program Files (x86)\DCC Tools\wiTECH\jserver\app\legacyVCI\lvci32.dll
    echo [FOUND] Chrysler wiTECH Legacy VCI ^(FCA native^)
    goto :write_bridge
)
REM FALLBACK: Autel MaxiFlash Elite/Pro
if exist "C:\Windows\SysWOW64\CFJW432.DLL" (
    set DLL_PATH=C:\Windows\SysWOW64\CFJW432.DLL
    echo [FOUND] Autel MaxiFlash Elite/Pro ^(fallback — connect Autel VCI^)
    goto :write_bridge
)

REM Registry fallback
for /f "tokens=2*" %%A in ('reg query "HKLM\SOFTWARE\WOW6432Node\PassThruSupport.04.04" /s /v "FunctionLibrary" 2^>nul') do (
    if "!DLL_PATH!"=="" set DLL_PATH=%%B
)
if "!DLL_PATH!"=="" (
    echo [ERROR] No J2534 DLL found. Install TOPDON R-Link software.
    pause & exit /b 1
)

:write_bridge
echo [DLL]  !DLL_PATH!
echo [PORT] %BRIDGE_PORT%
echo.

REM Write the Python bridge to a temp file
(
echo import argparse, ctypes, os, platform, socket, sys, threading
echo from ctypes import byref, c_ulong
echo from http.server import BaseHTTPRequestHandler, HTTPServer
echo import json
echo.
echo PROTOCOL_ISO15765=6
echo ISO15765_FRAME_PAD=0x40
echo CAN_29BIT_ID=0x100
echo FLOW_CONTROL=3
echo ERRORS={0:'OK',8:'ERR_DEVICE_NOT_CONNECTED',9:'ERR_TIMEOUT'}
echo.
echo class PASSTHRU_MSG^(ctypes.Structure^):
echo     _fields_=[^('ProtocolID',c_ulong^),^('RxStatus',c_ulong^),^('TxFlags',c_ulong^),^('Timestamp',c_ulong^),^('DataSize',c_ulong^),^('ExtraDataIndex',c_ulong^),^('Data',ctypes.c_ubyte*4128^)]
echo.
echo class J2534:
echo     def __init__^(self,dll_path,verbose=False^):
echo         self.dll_path=dll_path;self.verbose=verbose;self.dll=None
echo         self.device_id=c_ulong^(0^);self.channel_id=c_ulong^(0^)
echo         self.is_open=False;self.is_connected=False;self._lock=threading.Lock^(^)
echo         self.firmware=self.dll_ver=self.api_ver=self.serial=None
echo         self.vendor=os.path.basename^(dll_path^).lower^(^)
echo     def load^(self^):
echo         self.dll=ctypes.WinDLL^(self.dll_path^) if platform.system^(^)=='Windows' else ctypes.CDLL^(self.dll_path^)
echo         for fn,at,rt in [^('PassThruOpen',^[ctypes.c_void_p,ctypes.POINTER^(c_ulong^)],ctypes.c_long^),^('PassThruClose',^[c_ulong],ctypes.c_long^),^('PassThruConnect',^[c_ulong,c_ulong,c_ulong,c_ulong,ctypes.POINTER^(c_ulong^)],ctypes.c_long^),^('PassThruDisconnect',^[c_ulong],ctypes.c_long^),^('PassThruReadMsgs',^[c_ulong,ctypes.POINTER^(PASSTHRU_MSG^),ctypes.POINTER^(c_ulong^),c_ulong],ctypes.c_long^),^('PassThruWriteMsgs',^[c_ulong,ctypes.POINTER^(PASSTHRU_MSG^),ctypes.POINTER^(c_ulong^),c_ulong],ctypes.c_long^),^('PassThruStartMsgFilter',^[c_ulong,c_ulong,ctypes.POINTER^(PASSTHRU_MSG^),ctypes.POINTER^(PASSTHRU_MSG^),ctypes.POINTER^(PASSTHRU_MSG^),ctypes.POINTER^(c_ulong^)],ctypes.c_long^)]:
echo             f=getattr^(self.dll,fn^);f.argtypes=at;f.restype=rt
echo         try:
echo             self.dll.PassThruReadVersion.argtypes=[c_ulong,ctypes.c_char_p,ctypes.c_char_p,ctypes.c_char_p];self.dll.PassThruReadVersion.restype=ctypes.c_long
echo         except:pass
echo     def open^(self^):
echo         s=self.dll.PassThruOpen^(None,byref^(self.device_id^)^)
echo         if s!=0:raise Exception^(f'PassThruOpen failed: {ERRORS.get^(s,hex^(s^)^)}'  ^)
echo         self.is_open=True
echo         try:
echo             fw=ctypes.create_string_buffer^(80^);dv=ctypes.create_string_buffer^(80^);av=ctypes.create_string_buffer^(80^)
echo             if self.dll.PassThruReadVersion^(self.device_id,fw,dv,av^)==0:
echo                 self.firmware=fw.value.decode^(^);self.dll_ver=dv.value.decode^(^);self.api_ver=av.value.decode^(^)
echo         except:pass
echo     def connect^(self,protocol=6,flags=0,baud=500000^):
echo         s=self.dll.PassThruConnect^(self.device_id,c_ulong^(protocol^),c_ulong^(flags^),c_ulong^(baud^),byref^(self.channel_id^)^)
echo         if s!=0:raise Exception^(f'PassThruConnect failed: {ERRORS.get^(s,hex^(s^)^)}'  ^)
echo         self.is_connected=True
echo     def close^(self^):
echo         try:self.dll.PassThruDisconnect^(self.channel_id^)
echo         except:pass
echo         try:self.dll.PassThruClose^(self.device_id^)
echo         except:pass
echo         self.is_open=False;self.is_connected=False
echo     def _build^(self,pid,cid,data,flags=0^):
echo         m=PASSTHRU_MSG^(^);m.ProtocolID=pid;m.TxFlags=flags
echo         raw=cid.to_bytes^(4,'big'^)+bytes^(data^)
echo         m.DataSize=len^(raw^)
echo         for i,b in enumerate^(raw^):m.Data[i]=b
echo         return m
echo     def set_filter^(self,tx_id,rx_id^):
echo         pid=PROTOCOL_ISO15765;flags=0
echo         mask=self._build^(pid,0xFFFFFFFF,b'',flags^);pat=self._build^(pid,rx_id,b'',flags^);flow=self._build^(pid,tx_id,b'',flags^)
echo         fid=c_ulong^(0^);s=self.dll.PassThruStartMsgFilter^(self.channel_id,c_ulong^(FLOW_CONTROL^),byref^(mask^),byref^(pat^),byref^(flow^),byref^(fid^)^)
echo         return int^(fid.value^) if s==0 else None
echo     def write_msg^(self,tx_id,data,flags=ISO15765_FRAME_PAD,timeout_ms=1000^):
echo         m=self._build^(PROTOCOL_ISO15765,tx_id,data,flags^);n=c_ulong^(1^)
echo         s=self.dll.PassThruWriteMsgs^(self.channel_id,byref^(m^),byref^(n^),c_ulong^(timeout_ms^)^)
echo         if s!=0:raise Exception^(f'WriteMsgs: {ERRORS.get^(s,hex^(s^)^)}'  ^)
echo     def read_msg^(self,timeout_ms=1500,max_msgs=20^):
echo         import time;deadline=time.monotonic^(^)+timeout_ms/1000
echo         while time.monotonic^(^)^<deadline:
echo             arr=^(PASSTHRU_MSG*max_msgs^)^(^);n=c_ulong^(max_msgs^)
echo             s=self.dll.PassThruReadMsgs^(self.channel_id,arr,byref^(n^),c_ulong^(50^)^)
echo             for i in range^(int^(n.value^)^):
echo                 m=arr[i];sz=int^(m.DataSize^)
echo                 if sz^>4:return {'ok':True,'data':bytes^(m.Data[4:sz]^).hex^(^),'can_id':int.from_bytes^(bytes^(m.Data[:4]^),'big'^)}
echo         return {'ok':False,'error':'timeout'}
echo.
echo device=None
echo verbose=False
echo.
echo class H^(BaseHTTPRequestHandler^):
echo     def log_message^(self,*a^):
echo         if verbose:super^(^).log_message^(*a^)
echo     def _j^(self,d,code=200^):
echo         b=json.dumps^(d^).encode^(^);self.send_response^(code^);self.send_header^('Content-Type','application/json'^);self.send_header^('Content-Length',str^(len^(b^)^)^);self.send_header^('Access-Control-Allow-Origin','*'^);self.end_headers^(^);self.wfile.write^(b^)
echo     def do_OPTIONS^(self^):
echo         self.send_response^(204^);self.send_header^('Access-Control-Allow-Origin','*'^);self.send_header^('Access-Control-Allow-Methods','GET,POST,OPTIONS'^);self.send_header^('Access-Control-Allow-Headers','Content-Type'^);self.end_headers^(^)
echo     def do_GET^(self^):
echo         if self.path=='/status':
echo             self._j^({'ok':True,'version':'1.0.0','bridge':'srt-lab-j2534','platform':platform.system^(^),'vci':{'name':device.vendor,'firmware':device.firmware,'dll_version':device.dll_ver,'api_version':device.api_ver,'is_open':device.is_open,'is_connected':device.is_connected} if device else None}^)
echo         else:self._j^({'error':'not found'},404^)
echo     def do_POST^(self^):
echo         global device
echo         ln=int^(self.headers.get^('Content-Length',0^)^)
echo         body=json.loads^(self.rfile.read^(ln^)^) if ln else {}
echo         p=self.path
echo         try:
echo             if p=='/open':device.open^(^);self._j^({'ok':True,'device_id':int^(device.device_id.value^),'firmware':device.firmware,'dll_version':device.dll_ver}^)
echo             elif p=='/connect':
echo                 pr=body.get^('protocol',6^);fl=body.get^('flags',0^);br=body.get^('baudrate',500000^)
echo                 device.connect^(pr,fl,br^);self._j^({'ok':True,'channel_id':int^(device.channel_id.value^)}^)
echo             elif p=='/close':device.close^(^);self._j^({'ok':True}^)
echo             elif p=='/sendmsg':
echo                 tx=int^(body['tx_id'],16^) if isinstance^(body['tx_id'],str^) else body['tx_id']
echo                 data=bytes.fromhex^(body['data']^) if isinstance^(body['data'],str^) else bytes^(body['data']^)
echo                 device.write_msg^(tx,data,body.get^('flags',ISO15765_FRAME_PAD^),body.get^('timeout_ms',1000^)^);self._j^({'ok':True}^)
echo             elif p=='/readmsg':
echo                 r=device.read_msg^(body.get^('timeout_ms',1500^),body.get^('max_msgs',20^)^);self._j^(r^)
echo             elif p=='/setfilter':
echo                 tx=int^(body['tx_id'],16^) if isinstance^(body['tx_id'],str^) else body['tx_id']
echo                 rx=int^(body['rx_id'],16^) if isinstance^(body['rx_id'],str^) else body['rx_id']
echo                 fid=device.set_filter^(tx,rx^);self._j^({'ok':True,'filter_id':fid}^)
echo             else:self._j^({'error':'not found'},404^)
echo         except Exception as e:self._j^({'ok':False,'error':str^(e^)},500^)
echo.
echo if __name__=='__main__':
echo     ap=argparse.ArgumentParser^(^);ap.add_argument^('--dll',required=True^);ap.add_argument^('--port',type=int,default=8765^);ap.add_argument^('--verbose',action='store_true'^);a=ap.parse_args^(^)
echo     verbose=a.verbose;device=J2534^(a.dll,a.verbose^)
echo     print^(f'SRT Lab J2534 Bridge v1.0'^);print^(f'DLL: {a.dll}'^)
echo     device.load^(^);print^('[OK] DLL loaded'^)
echo     try:device.open^(^);print^(f'[OK] Device opened'^)
echo     except Exception as e:print^(f'[WARN] {e} - will retry on demand'^)
echo     print^(f'[OK] Listening on http://127.0.0.1:{a.port}'^)
echo     print^('Set bridge URL in SRT Lab to: http://localhost:'+str^(a.port^)^)
echo     HTTPServer^(^('127.0.0.1',a.port^),H^).serve_forever^(^)
) > "%TMPPY%"

echo [OK] Bridge script written to temp
echo.

where python3 >nul 2>&1
if %ERRORLEVEL%==0 (
    python3 "%TMPPY%" --dll "!DLL_PATH!" --port %BRIDGE_PORT% --verbose
) else (
    python "%TMPPY%" --dll "!DLL_PATH!" --port %BRIDGE_PORT% --verbose
)

del "%TMPPY%" 2>nul
if %ERRORLEVEL% NEQ 0 (
    echo.
    echo [ERROR] Bridge failed. Make sure Python 3 is installed.
    echo  https://www.python.org/downloads/
    pause
)
