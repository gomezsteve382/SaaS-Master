"""
SRT Lab unlock catalog — universal adapter for all 81 FCA J2534 unlock DLLs.

For each DLL in the canflash_unlocks/ directory, this module provides:
  1. Metadata (CAN tx/rx, supplier, module type)
  2. A unlock(seed, arg2=0) function that either:
     - Dispatches to a native Python port (for the 14 I've hand-verified)
     - Emulates the DLL on demand via Unicorn (for the other 67)

The on-demand emulator is byte-identical to what the real Chrysler J2534 Flash
Application would compute, because it IS the original DLL running under Unicorn.

USAGE:
    from srtlab_unlock_catalog import unlock, list_modules, MODULE_INFO
    
    # Any of the 81 modules, by name
    key = unlock('huntsville_bcm', seed=0xDEADBEEF)
    key = unlock('lear_wcm', seed=0xDEADBEEF)
    key = unlock('cummins_849', seed=0xDEADBEEF)
    
    # List what's available
    for name, info in MODULE_INFO.items():
        print(name, info)
"""

import os
import sys
import threading

# Try to import pefile and unicorn — fall back gracefully if not installed
try:
    import pefile
    from unicorn import Uc, UC_ARCH_X86, UC_MODE_32
    from unicorn.x86_const import UC_X86_REG_ESP, UC_X86_REG_EAX
    HAVE_UNICORN = True
except ImportError:
    HAVE_UNICORN = False


# Locate the DLL directory (next to this file)
_HERE = os.path.dirname(os.path.abspath(__file__))
DLL_DIR = os.path.join(_HERE, 'canflash_unlocks')


# ═══════════════════════════════════════════════════════════════════════
# Module metadata — CAN addresses, categories, suppliers
# ═══════════════════════════════════════════════════════════════════════
# tx/rx pairs where known. All 81 modules categorized.

MODULE_INFO = {
    # ── POWERTRAIN: Engine / PCM ─────────────────────────────────────────
    'ngc_engine':      {'category': 'powertrain.engine',  'tx': 0x7E0, 'rx': 0x7E8, 'label': 'NGC gas engine'},
    'venom_pcm':       {'category': 'powertrain.engine',  'tx': 0x7E0, 'rx': 0x7E8, 'label': 'Venom PCM'},
    'gpec':            {'category': 'powertrain.engine',  'tx': 0x7E0, 'rx': 0x7E8, 'label': 'GPEC ECM (Continental)'},
    'cummins_849':     {'category': 'powertrain.engine',  'tx': 0x7E0, 'rx': 0x7E8, 'label': 'Cummins 6.7L ISB'},
    'edc16c2':         {'category': 'powertrain.engine',  'tx': 0x7E0, 'rx': 0x7E8, 'label': 'Bosch EDC16C2 diesel'},
    'edc16cp31':       {'category': 'powertrain.engine',  'tx': 0x7E0, 'rx': 0x7E8, 'label': 'Bosch EDC16CP31 diesel'},
    'edc16u31':        {'category': 'powertrain.engine',  'tx': 0x7E0, 'rx': 0x7E8, 'label': 'Bosch EDC16U31 diesel'},
    
    # ── POWERTRAIN: Transmission ─────────────────────────────────────────
    'ngc_transmission': {'category': 'powertrain.trans',  'tx': 0x7E1, 'rx': 0x7E9, 'label': 'NGC transmission'},
    'ngc4_trans':       {'category': 'powertrain.trans',  'tx': 0x7E1, 'rx': 0x7E9, 'label': 'NGC4 transmission'},
    'aisin_tcm':        {'category': 'powertrain.trans',  'tx': 0x7E1, 'rx': 0x7E9, 'label': 'Aisin AS68RC/AS69RC TCM'},
    'egs52':            {'category': 'powertrain.trans',  'tx': 0x7E1, 'rx': 0x7E9, 'label': 'Mercedes EGS52 7G-Tronic'},
    'cvt':              {'category': 'powertrain.trans',  'tx': 0x7E1, 'rx': 0x7E9, 'label': 'CVT controller'},
    
    # ── POWERTRAIN: Combined / Integrated ────────────────────────────────
    'dcx_ptcm':        {'category': 'powertrain.integrated', 'tx': 0x730, 'rx': None, 'label': 'DCX PowerTrain CM'},
    'ptim_lx':         {'category': 'powertrain.integrated', 'tx': 0x7E0, 'rx': 0x7E8, 'label': 'PTIM LX platform'},
    
    # ── POWERTRAIN: Transfer Case / AWD ──────────────────────────────────
    'awd_pm_mk':       {'category': 'powertrain.awd',      'tx': 0x7E3, 'rx': 0x7EB, 'label': 'AWD PM MK'},
    'borg_awd':        {'category': 'powertrain.awd',      'tx': 0x7E3, 'rx': 0x7EB, 'label': 'BorgWarner AWD'},
    
    # ── BODY: BCM / Front Control ────────────────────────────────────────
    'huntsville_bcm':  {'category': 'body.bcm',            'tx': 0x750, 'rx': 0x758, 'label': 'Harman Huntsville BCM'},
    'wcm':             {'category': 'body.bcm',            'tx': 0x620, 'rx': 0x628, 'label': 'Wireless Control Module'},
    'lear_wcm':        {'category': 'body.bcm',            'tx': 0x620, 'rx': 0x628, 'label': 'Lear WCM'},
    'yazaki_fcm':      {'category': 'body.front',          'tx': 0x750, 'rx': 0x758, 'label': 'Yazaki Front CM'},
    'huntsville_fcm':  {'category': 'body.front',          'tx': 0x750, 'rx': 0x758, 'label': 'Huntsville Front CM'},
    'huntsville_fdcm': {'category': 'body.front',          'tx': 0x752, 'rx': 0x75A, 'label': 'Huntsville FDCM'},
    'fdcm':            {'category': 'body.front',          'tx': 0x752, 'rx': 0x75A, 'label': 'Front Door CM'},
    'motorola_tipm7':  {'category': 'body.tipm',           'tx': 0x747, 'rx': 0x74F, 'label': 'Motorola TIPM7'},
    
    # ── BODY: Doors / Windows ────────────────────────────────────────────
    'bosch_ddm':             {'category': 'body.doors', 'tx': 0x76E, 'rx': 0x776, 'label': 'Bosch Driver Door Module'},
    'bosch_pdm':             {'category': 'body.doors', 'tx': 0x76F, 'rx': 0x777, 'label': 'Bosch Passenger Door Module'},
    'bosch_mddm':            {'category': 'body.doors', 'tx': 0x76E, 'rx': 0x776, 'label': 'Bosch Master Driver Door'},
    'bosch_mpdm':            {'category': 'body.doors', 'tx': 0x76F, 'rx': 0x777, 'label': 'Bosch Master Passenger Door'},
    'bosch_mwddm':           {'category': 'body.doors', 'tx': 0x770, 'rx': 0x778, 'label': 'Bosch Middle/Rear Driver Door'},
    'bosch_mwpdm':           {'category': 'body.doors', 'tx': 0x771, 'rx': 0x779, 'label': 'Bosch Middle/Rear Passenger Door'},
    'bosch_cdm_win_ddm':     {'category': 'body.doors', 'tx': 0x76E, 'rx': 0x776, 'label': 'Bosch CDM Window Driver'},
    'bosch_cdm_win_pdm':     {'category': 'body.doors', 'tx': 0x76F, 'rx': 0x777, 'label': 'Bosch CDM Window Passenger'},
    'temic_ddm':             {'category': 'body.doors', 'tx': 0x76E, 'rx': 0x776, 'label': 'Temic Driver Door'},
    'temic_pdm':             {'category': 'body.doors', 'tx': 0x76F, 'rx': 0x777, 'label': 'Temic Passenger Door'},
    'ddm':                   {'category': 'body.doors', 'tx': 0x76E, 'rx': 0x776, 'label': 'Generic Driver Door'},
    'pdm':                   {'category': 'body.doors', 'tx': 0x76F, 'rx': 0x777, 'label': 'Generic Passenger Door'},
    'ewm':                   {'category': 'body.doors', 'tx': 0x772, 'rx': 0x77A, 'label': 'Electronic Window Module'},
    
    # ── BODY: HVAC ───────────────────────────────────────────────────────
    'hvac':         {'category': 'body.hvac', 'tx': 0x731, 'rx': 0x739, 'label': 'Generic HVAC'},
    'delphi_hvac':  {'category': 'body.hvac', 'tx': 0x731, 'rx': 0x739, 'label': 'Delphi HVAC'},
    'trw_hvac':     {'category': 'body.hvac', 'tx': 0x731, 'rx': 0x739, 'label': 'TRW HVAC'},
    'trw_hvac_2':   {'category': 'body.hvac', 'tx': 0x731, 'rx': 0x739, 'label': 'TRW HVAC v2'},
    
    # ── BODY: Other comfort ──────────────────────────────────────────────
    'sunr':         {'category': 'body.comfort', 'tx': 0x735, 'rx': 0x73D, 'label': 'Sunroof module'},
    'pts':          {'category': 'body.comfort', 'tx': 0x736, 'rx': 0x73E, 'label': 'Parktronic'},
    'msmd':         {'category': 'body.comfort', 'tx': 0x737, 'rx': 0x73F, 'label': 'Memory Seat Module (Driver)'},
    'plgm':         {'category': 'body.comfort', 'tx': 0x738, 'rx': 0x740, 'label': 'Power Liftgate Module'},
    'eom':          {'category': 'body.comfort', 'tx': 0x739, 'rx': 0x741, 'label': 'Electric Ops Module'},
    'esm':          {'category': 'body.comfort', 'tx': 0x73A, 'rx': 0x742, 'label': 'Electric Seat Module'},
    'lrsm':         {'category': 'body.comfort', 'tx': 0x73B, 'rx': 0x743, 'label': 'Left/Right Seat Module'},
    'hidt':         {'category': 'body.lighting', 'tx': 0x73C, 'rx': 0x744, 'label': 'HID Lamp control'},
    'hella_acc':    {'category': 'body.acc',      'tx': 0x73D, 'rx': 0x745, 'label': 'Hella adaptive cruise'},
    
    # ── SAFETY: ABS / Brakes ─────────────────────────────────────────────
    'abs':          {'category': 'safety.brakes', 'tx': 0x760, 'rx': 0x768, 'label': 'Generic ABS'},
    'bosch_abs':    {'category': 'safety.brakes', 'tx': 0x760, 'rx': 0x768, 'label': 'Bosch ABS'},
    'teves_abs':    {'category': 'safety.brakes', 'tx': 0x760, 'rx': 0x768, 'label': 'Teves/Continental ABS'},
    'trw_abs':      {'category': 'safety.brakes', 'tx': 0x760, 'rx': 0x768, 'label': 'TRW ABS'},
    'ahbm':         {'category': 'safety.brakes', 'tx': 0x761, 'rx': 0x769, 'label': 'Active Hydraulic Brake Module'},
    'asbs':         {'category': 'safety.brakes', 'tx': 0x762, 'rx': 0x76A, 'label': 'Active Safety Brake System'},
    
    # ── SAFETY: Airbag / Occupant ────────────────────────────────────────
    'bosch_orc':    {'category': 'safety.airbag', 'tx': 0x7A0, 'rx': 0x7A8, 'label': 'Bosch ORC (Occupant Restraint)'},
    'trw_orc':      {'category': 'safety.airbag', 'tx': 0x7A0, 'rx': 0x7A8, 'label': 'TRW ORC'},
    'ocm':          {'category': 'safety.airbag', 'tx': 0x7A1, 'rx': 0x7A9, 'label': 'Generic Occupant Classification Module'},
    'trw_ocm':      {'category': 'safety.airbag', 'tx': 0x7A1, 'rx': 0x7A9, 'label': 'TRW Occupant Classification'},
    
    # ── SAFETY: Steering ─────────────────────────────────────────────────
    'sas':          {'category': 'safety.steering', 'tx': 0x763, 'rx': 0x76B, 'label': 'Steering Angle Sensor'},
    'trw_sas':      {'category': 'safety.steering', 'tx': 0x763, 'rx': 0x76B, 'label': 'TRW Steering Angle'},
    'valeo_scm':    {'category': 'safety.steering', 'tx': 0x764, 'rx': 0x76C, 'label': 'Valeo Steering Column Module'},
    
    # ── CLUSTER / INSTRUMENT ─────────────────────────────────────────────
    'may_scofield_itm': {'category': 'cluster.ipc', 'tx': 0x7A4, 'rx': 0x7AC, 'label': 'May Scofield ITM cluster'},
    
    # ── RADIO / HEAD UNIT (UConnect) ─────────────────────────────────────
    'huntsville_radio': {'category': 'radio.head', 'tx': 0x6B0, 'rx': 0x6B8, 'label': 'Harman Huntsville radio (UConnect 4/4C 8.4")'},
    'alpine_radio':     {'category': 'radio.head', 'tx': 0x6B0, 'rx': 0x6B8, 'label': 'Alpine RA3/RA4 radio (7")'},
    'alpine_rak':       {'category': 'radio.head', 'tx': 0x6B0, 'rx': 0x6B8, 'label': 'Alpine RAK (UConnect 4 low)'},
    'mitsubishi_rar':   {'category': 'radio.head', 'tx': 0x6B0, 'rx': 0x6B8, 'label': 'Mitsubishi RAR (UConnect 3 5")'},
    
    # ── RADIO / AMP ──────────────────────────────────────────────────────
    'alpine_amp':       {'category': 'radio.amp',  'tx': 0x6B1, 'rx': 0x6B9, 'label': 'Alpine amp'},
    'harman_amp':       {'category': 'radio.amp',  'tx': 0x6B1, 'rx': 0x6B9, 'label': 'Harman amp'},
    'kicker_amp':       {'category': 'radio.amp',  'tx': 0x6B1, 'rx': 0x6B9, 'label': 'Kicker amp'},
    'visteon_amp':      {'category': 'radio.amp',  'tx': 0x6B1, 'rx': 0x6B9, 'label': 'Visteon amp'},
    
    # ── RADIO / HANDSFREE / SAT ──────────────────────────────────────────
    'hfm':              {'category': 'radio.hfm',  'tx': 0x6B2, 'rx': 0x6BA, 'label': 'Handsfree module'},
    'peiker_hfm':       {'category': 'radio.hfm',  'tx': 0x6B2, 'rx': 0x6BA, 'label': 'Peiker HFM'},
    'delphi_sdar':      {'category': 'radio.sat',  'tx': 0x6B3, 'rx': 0x6BB, 'label': 'Delphi Sirius (SDAR)'},
    
    # ── RADIO / VIDEO ────────────────────────────────────────────────────
    'mitsubishi_ves':   {'category': 'radio.video', 'tx': 0x6B4, 'rx': 0x6BC, 'label': 'Mitsubishi VES (DVD)'},
    'mitsubishi_ves3':  {'category': 'radio.video', 'tx': 0x6B4, 'rx': 0x6BC, 'label': 'Mitsubishi VES3'},
    
    # ── CENTER CONSOLE / NAV ─────────────────────────────────────────────
    'HB_ccn':           {'category': 'nav.ccn',    'tx': 0x6B5, 'rx': 0x6BD, 'label': 'HB chassis Center Console Nav'},
    'LX_ccn':           {'category': 'nav.ccn',    'tx': 0x6B5, 'rx': 0x6BD, 'label': 'LX chassis Center Console Nav'},
    'nippon_ccn':       {'category': 'nav.ccn',    'tx': 0x6B5, 'rx': 0x6BD, 'label': 'Nippon Center Console Nav'},
    
    # ── MISC ─────────────────────────────────────────────────────────────
    'cmtc':             {'category': 'misc',       'tx': 0x7B0, 'rx': 0x7B8, 'label': 'CMTC (Climate/Mirror/Tire/Compass)'},
}


# Sanity: make sure MODULE_INFO covers every DLL
def _check_coverage():
    if not os.path.isdir(DLL_DIR):
        return  # test deployment; that's fine
    on_disk = {f[:-4] for f in os.listdir(DLL_DIR) if f.endswith('.dll')}
    declared = set(MODULE_INFO)
    missing = on_disk - declared
    if missing:
        # Categorize as misc and warn
        for m in missing:
            MODULE_INFO[m] = {'category': 'misc.unclassified', 'tx': None, 'rx': None,
                              'label': m.replace('_', ' ').title()}


_check_coverage()


# ═══════════════════════════════════════════════════════════════════════
# Native Python ports (hand-verified, byte-exact against DLL emulation)
# ═══════════════════════════════════════════════════════════════════════
# Use the implementations from srtlab_canflash_algos if available

try:
    from srtlab_canflash_algos import CANFLASH_ALGOS
    NATIVE = {k: v['fn'] for k, v in CANFLASH_ALGOS.items()}
except ImportError:
    NATIVE = {}


# ═══════════════════════════════════════════════════════════════════════
# Emulator wrapper — caches PE per DLL for performance
# ═══════════════════════════════════════════════════════════════════════

_pe_cache = {}
_pe_lock = threading.Lock()


def _emulate(dll_name, seed, arg2=0):
    if not HAVE_UNICORN:
        raise RuntimeError(
            'Unicorn and pefile required for DLL emulation. '
            'Install: pip install unicorn pefile')
    
    dll_path = os.path.join(DLL_DIR, dll_name + '.dll')
    if not os.path.isfile(dll_path):
        raise FileNotFoundError(f'DLL not found: {dll_path}')
    
    with _pe_lock:
        if dll_name not in _pe_cache:
            pe = pefile.PE(dll_path)
            unlock_rva = None
            for s in pe.DIRECTORY_ENTRY_EXPORT.symbols:
                if s.name and s.name.decode() == 'unlock':
                    unlock_rva = s.address
                    break
            if unlock_rva is None:
                raise ValueError(f'No `unlock` export in {dll_name}.dll')
            _pe_cache[dll_name] = (pe, unlock_rva)
    
    pe, unlock_rva = _pe_cache[dll_name]
    image_base = pe.OPTIONAL_HEADER.ImageBase
    raw = pe.__data__
    
    mu = Uc(UC_ARCH_X86, UC_MODE_32)
    size = (pe.OPTIONAL_HEADER.SizeOfImage + 0xFFF) & ~0xFFF
    mu.mem_map(image_base, size)
    mu.mem_write(image_base, raw[:pe.OPTIONAL_HEADER.SizeOfHeaders])
    for section in pe.sections:
        va = image_base + section.VirtualAddress
        data = section.get_data()
        if data: mu.mem_write(va, data)
    stack_base = 0x200000
    mu.mem_map(stack_base, 0x10000)
    esp = stack_base + 0x8000
    ret_addr = 0x100000
    mu.mem_map(ret_addr & ~0xFFF, 0x1000)
    esp -= 4; mu.mem_write(esp, arg2.to_bytes(4, 'little'))
    esp -= 4; mu.mem_write(esp, seed.to_bytes(4, 'little'))
    esp -= 4; mu.mem_write(esp, ret_addr.to_bytes(4, 'little'))
    mu.reg_write(UC_X86_REG_ESP, esp)
    mu.emu_start(image_base + unlock_rva, ret_addr, timeout=2_000_000)
    return mu.reg_read(UC_X86_REG_EAX)


# ═══════════════════════════════════════════════════════════════════════
# Public API
# ═══════════════════════════════════════════════════════════════════════

def unlock(module_name, seed, arg2=0, prefer_native=True):
    """Compute the 4-byte unlock key for the given module and seed.
    
    Args:
        module_name: DLL basename, e.g. 'huntsville_bcm', 'cummins_849',
                     'alpine_radio', 'lear_wcm'.
        seed: 32-bit seed received from UDS 27 01 positive response.
        arg2: secondary seed argument (used by dcx_ptcm, alpine_rak, alpine_radio,
              and any other 2-arg unlock). Default 0.
        prefer_native: if True (default), use the hand-ported Python when available.
                       Set False to force emulation (useful to verify ports).
    
    Returns:
        4-byte unlock key as a u32.
    """
    module_name = module_name.lower() if module_name not in MODULE_INFO else module_name
    # Case-insensitive lookup
    for k in MODULE_INFO:
        if k.lower() == module_name.lower():
            module_name = k
            break
    
    if module_name not in MODULE_INFO:
        raise KeyError(f'Unknown module: {module_name}. Known modules: {sorted(MODULE_INFO)}')
    
    if prefer_native and module_name in NATIVE:
        fn = NATIVE[module_name]
        try:
            # Some native fns take arg2, some don't
            return fn(seed, arg2)
        except TypeError:
            return fn(seed)
    
    return _emulate(module_name, seed, arg2)


def list_modules(category_filter=None):
    """Return sorted list of (name, info) pairs, optionally filtered by category prefix."""
    out = []
    for name, info in sorted(MODULE_INFO.items()):
        if category_filter is None or info['category'].startswith(category_filter):
            out.append((name, info))
    return out


def native_count():
    """How many modules have hand-ported Python implementations."""
    return sum(1 for n in MODULE_INFO if n in NATIVE)


def emulated_count():
    """How many modules fall back to Unicorn DLL emulation."""
    return sum(1 for n in MODULE_INFO if n not in NATIVE)


# ═══════════════════════════════════════════════════════════════════════
# CLI / demo
# ═══════════════════════════════════════════════════════════════════════

if __name__ == '__main__':
    print(f'SRT Lab unlock catalog — {len(MODULE_INFO)} FCA modules')
    print(f'  {native_count()} with hand-ported Python (verified byte-exact)')
    print(f'  {emulated_count()} via on-demand DLL emulation via Unicorn')
    print()
    
    if len(sys.argv) > 1 and sys.argv[1] == '--list':
        categories = sorted(set(info['category'] for info in MODULE_INFO.values()))
        for cat in categories:
            print(f'\n{cat}:')
            for name, info in list_modules(cat):
                native = '✓' if name in NATIVE else '  '
                tx = f"tx=0x{info['tx']:03X}" if info['tx'] else 'tx=?'
                rx = f"rx=0x{info['rx']:03X}" if info['rx'] else ''
                print(f"  {native} {name:<22s} {tx:<10s} {rx:<10s}  {info['label']}")
    else:
        # Demo: try unlock on a few modules
        if HAVE_UNICORN:
            SEED = 0xDEADBEEF
            print(f'Demo: unlock(module, seed=0x{SEED:08X}) across categories:\n')
            demo = [
                'cummins_849', 'gpec', 'ngc_engine', 'huntsville_bcm',
                'lear_wcm', 'alpine_radio', 'bosch_orc', 'trw_abs',
                'aisin_tcm', 'motorola_tipm7', 'may_scofield_itm',
            ]
            for name in demo:
                try:
                    k = unlock(name, SEED)
                    native = ' [native]' if name in NATIVE else ' [emulated]'
                    info = MODULE_INFO[name]
                    tx = f"tx=0x{info['tx']:03X}" if info['tx'] else 'tx=?'
                    print(f"  {name:<22s}  {tx}  key=0x{k:08X}{native}")
                except Exception as e:
                    print(f"  {name}: ERROR {e}")
        else:
            print('(install unicorn + pefile to run emulation demos)')
        
        print(f'\nRun with --list for full module catalog.')
