#!/usr/bin/env python3
"""Regenerates artifacts/srt-lab/src/lib/bcmFeatureCatalogExtra.js
from artifacts/srt-lab/public/unlock_catalog_extended.json.

The DEnn range (0xDE00..0xDE0C) is owned by the auto-mined
bcmFeatureCatalog.generated.js — this script intentionally skips it.
The 0x05AE entries are hand-tuned (Red Key option labels) and are
emitted first, before the bulk-extracted entries.

Bit positions are emitted as MSB-first 0..N in catalog order. AlfaOBD's
binary doesn't expose bit positions in the extracted JSON (the string
table is Dotfuscator-encrypted), so layouts MUST be confirmed against a
live BCM read before being trusted for writes. The catalog row order
is taken straight from the source JSON, which mirrors AlfaOBD's UI
order — the most likely (but not guaranteed) bit order.

Usage:
  python3 artifacts/srt-lab/scripts/extract-bcm-extras.py
"""
import json
import re
import collections
import os
import sys

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '..'))
SRC = os.path.join(ROOT, 'public', 'unlock_catalog_extended.json')
DST = os.path.join(ROOT, 'src', 'lib', 'bcmFeatureCatalogExtra.js')

# AlfaOBD BCM body parameter DID range observed in the mined JSON.
KEEP_LO, KEEP_HI = 0x04C0, 0x05DF
# 0x05AE is hand-tuned below — exclude from the bulk loop.
EXCLUDE = {0x05AE}


def clean(v: str):
    """Reject obfuscation-tail / numeric-encoded entries the catalog
    can't safely render as bit-flag toggles."""
    if re.search(r'X{4,}', v):
        return None
    if any(s in v for s in ('ECUConfig', 'VehConfig', 'ecucONFIG', 'xxxx')):
        return None
    if len(v) > 70 or len(v) < 3:
        return None
    return v.strip()


def main():
    with open(SRC) as f:
        catalog = json.load(f)

    rows = []

    def walk(obj):
        if isinstance(obj, dict):
            if (
                'did' in obj and 'value' in obj
                and isinstance(obj['did'], str)
                and isinstance(obj['value'], str)
            ):
                rows.append((obj['did'], obj['value']))
            for v in obj.values():
                walk(v)
        elif isinstance(obj, list):
            for v in obj:
                walk(v)

    walk(catalog)

    by_did = collections.defaultdict(list)
    seen = set()
    for did, val in rows:
        if (did, val) in seen:
            continue
        seen.add((did, val))
        by_did[did].append(val)

    groups = []
    for did_str in sorted(by_did.keys()):
        m = re.match(r'^0x([0-9A-Fa-f]{4})$', did_str)
        if not m:
            continue
        n = int(m.group(1), 16)
        if not (KEEP_LO <= n <= KEEP_HI):
            continue
        if n in EXCLUDE:
            continue
        fs = [c for v in by_did[did_str] if (c := clean(v))]
        if not fs:
            continue
        groups.append((n, fs))

    # 0x05AE — hand-tuned ordering and labels (Red Key feature)
    ae_fields = [
        ('Full Central Vision Processing Present', None),
        ('Surround View Camera Present', None),
        ('Air Suspension Control Module (ASCM) — Suspension', None),
        ('Air Suspension Control Module (ASCM) — Active Damping', None),
        ('Red Key Feature Present', [
            (0, 'Disabled (Black Key only)'),
            (1, 'Enabled (Red Key recognised)'),
        ]),
        ('Active Blind Spot Present', None),
    ]

    out = []
    out.append('/* Auto-generated from unlock_catalog_extended.json — BCM Body parameter DIDs')
    out.append(f' * in the 0x{KEEP_LO:04X}..0x{KEEP_HI:04X} range. {len(groups) + 1} DIDs, '
               f'{sum(len(fs) for _, fs in groups) + len(ae_fields)} fields.')
    out.append(' *')
    out.append(' * Regenerate with `python3 artifacts/srt-lab/scripts/extract-bcm-extras.py`.')
    out.append(' *')
    out.append(' * Bit positions are MSB-first 0..N in catalog order — provisional, confirm')
    out.append(' * against a live BCM read before trusting writes. */')
    out.append('')
    out.append('export const BCM_CONFIG_EXTRA_CATALOG = [')

    group = 'BCM Body Presence Flags (0x05AE)'
    for i, (name, opts) in enumerate(ae_fields):
        if opts:
            os_ = ','.join(f"{{value:{v},label:'{l}'}}" for v, l in opts)
        else:
            os_ = "{value:0,label:'Not present'},{value:1,label:'Present'}"
        out.append(f"  {{ request: '05AE', groupName: '{group}', name: '{name}', "
                   f"bit: {i}, length: 1, options: [{os_}] }},")

    for n, fs in groups:
        didhex = f"{n:04X}"
        group = f"BCM Body — DID 0x{didhex} ({len(fs)} field{'s' if len(fs) != 1 else ''})"
        for i, name in enumerate(fs):
            ne = name.replace('\\', '\\\\').replace("'", "\\'")
            out.append(f"  {{ request: '{didhex}', groupName: '{group}', "
                       f"name: '{ne}', bit: {i}, length: 1, "
                       f"options: [{{value:0,label:'No / Off'}},{{value:1,label:'Yes / On'}}] }},")
    out.append('];')
    out.append('')
    out.append('export const BCM_CONFIG_EXTRA_DIDS = [')
    out.append('  0x05AE,')
    for n, _ in groups:
        out.append(f'  0x{n:04X},')
    out.append('];')
    out.append('')

    text = '\n'.join(out)
    with open(DST, 'w') as f:
        f.write(text)
    total_fields = sum(len(fs) for _, fs in groups) + len(ae_fields)
    print(f'wrote {DST}: {len(groups) + 1} DIDs, {total_fields} fields')


if __name__ == '__main__':
    main()
