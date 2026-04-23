"""
SRT Lab DID decoder — translates scanner output into human-readable meanings.

Uses the AlfaOBD database (alfaobd_dids.json) plus the FCA module catalog
(srtlab_unlock_catalog) to explain what bytes from a module actually mean.

USE CASES:
    1. After a scan, decode config DIDs into feature flags
    2. Look up what a specific byte value means for a known DID
    3. Search for DIDs by keyword ("tell me all nav-related DIDs")
    4. Compare two modules' configs (e.g. donor vs vehicle)

USAGE:
    # Search for DIDs
    python srtlab_did_decode.py --search "rear camera"
    python srtlab_did_decode.py --search nav
    python srtlab_did_decode.py --search "max gear"

    # Decode a specific DID response (raw hex from UDS 22 xxxx)
    python srtlab_did_decode.py --did 0x2283 --value 1
    python srtlab_did_decode.py --did F190 --value "3C6RR7KT7KG553210"

    # List all DIDs in a scope
    python srtlab_did_decode.py --scope "VehConfig 1"
    python srtlab_did_decode.py --scope "ECUConfig 3"

    # Dump everything (useful piped to less or grep)
    python srtlab_did_decode.py --all

LIBRARY MODE:
    from srtlab_did_decode import DidDecoder
    d = DidDecoder()
    d.search("rear camera")  # list of matching DIDs
    d.decode(did="01225", byte=1, value=1)  # "Auto Highbeam: Yes"
    d.list_by_scope("VehConfig 1")
"""
import argparse
import json
import os
import re
import sys


class DidDecoder:
    def __init__(self, didfile=None):
        here = os.path.dirname(os.path.abspath(__file__))
        didfile = didfile or os.path.join(here, 'alfaobd_dids.json')
        
        if not os.path.isfile(didfile):
            raise FileNotFoundError(
                f'alfaobd_dids.json not found at {didfile}. '
                f'Run the AlfaOBD extraction tools first.')
        
        with open(didfile) as f:
            self.dids = json.load(f)
        
        # Build search indices
        self._by_description = {}  # lowercase word → list of entries
        self._by_scope = {}  # scope → list of entries
        self._by_id = {}  # did_id → list (same id can have multiple bit positions)
        
        for entry in self.dids:
            # Index by lowercase words in description
            for word in re.findall(r'\w+', entry['description'].lower()):
                self._by_description.setdefault(word, []).append(entry)
            # Index by scope
            if entry['scope']:
                self._by_scope.setdefault(entry['scope'], []).append(entry)
            # Index by ID
            self._by_id.setdefault(entry['did_id'], []).append(entry)
    
    def search(self, keyword):
        """Find all DIDs whose description contains the keyword."""
        keyword = keyword.lower()
        matches = []
        seen = set()
        # Multi-word: require all words present
        words = re.findall(r'\w+', keyword)
        for word in words:
            partial = self._by_description.get(word, [])
            for e in partial:
                # Check ALL words are in description
                desc_lower = e['description'].lower()
                if all(w in desc_lower for w in words):
                    key = (e['did_id'], e['byte_pos'], e['description'])
                    if key not in seen:
                        seen.add(key)
                        matches.append(e)
        # Also raw substring search
        for e in self.dids:
            if keyword in e['description'].lower():
                key = (e['did_id'], e['byte_pos'], e['description'])
                if key not in seen:
                    seen.add(key)
                    matches.append(e)
        return matches
    
    def list_by_scope(self, scope):
        """All DIDs belonging to a scope, e.g. 'VehConfig 1'."""
        exact = self._by_scope.get(scope, [])
        if exact: return exact
        # Partial match
        matches = []
        for s, items in self._by_scope.items():
            if scope.lower() in s.lower():
                matches.extend(items)
        return matches
    
    def list_all_scopes(self):
        return sorted(self._by_scope.keys())
    
    def decode_value(self, did_id, byte_pos, value):
        """For a given DID id + byte position + numeric value, return the enum meaning."""
        candidates = self._by_id.get(did_id, [])
        for c in candidates:
            if c['byte_pos'] == byte_pos:
                # JSON loads keys as strings, so try both int and str
                vs = c['values']
                for key in (value, str(value), int(value) if str(value).isdigit() else None):
                    if key is not None and key in vs:
                        return {
                            'description': c['description'],
                            'value': value,
                            'meaning': vs[key],
                            'scope': c['scope'],
                        }
                if vs:
                    return {
                        'description': c['description'],
                        'value': value,
                        'meaning': f'(unknown value — known values: {list(vs.keys())})',
                        'scope': c['scope'],
                    }
        return None
    
    def format_entry(self, e, indent=''):
        lines = []
        title = f'{e["did_id"]}[{e["byte_pos"]}:{e["byte_pos"]+e["width"]-1}]'
        lines.append(f'{indent}{title:<14s} {e["description"]}')
        if e['values']:
            for k in sorted(e['values'].keys()):
                lines.append(f'{indent}    {k}: {e["values"][k]}')
        if e['scope']:
            lines.append(f'{indent}    scope: {e["scope"]}')
        return '\n'.join(lines)


def main():
    ap = argparse.ArgumentParser(description='SRT Lab DID decoder')
    ap.add_argument('--search', help='Search DIDs by description keyword(s)')
    ap.add_argument('--scope', help='List all DIDs in a scope (e.g. "VehConfig 1")')
    ap.add_argument('--did', help='Look up a specific DID id (e.g. 01225)')
    ap.add_argument('--byte', type=int, help='Byte position (for --did)')
    ap.add_argument('--value', type=int, help='Value to decode (for --did)')
    ap.add_argument('--all', action='store_true', help='Dump all DIDs')
    ap.add_argument('--scopes', action='store_true', help='List all scopes')
    ap.add_argument('--stats', action='store_true', help='Show statistics')
    args = ap.parse_args()
    
    d = DidDecoder()
    
    if args.stats:
        scopes = d.list_all_scopes()
        print(f"AlfaOBD DID database")
        print(f"  Total DID entries: {len(d.dids)}")
        print(f"  Unique scopes: {len(scopes)}")
        print(f"  Scopes: {', '.join(scopes)}")
        return 0
    
    if args.scopes:
        print("Scopes defined in the database:")
        for s in d.list_all_scopes():
            entries = d.list_by_scope(s)
            print(f"  {s}  ({len(entries)} DIDs)")
        return 0
    
    if args.search:
        matches = d.search(args.search)
        if not matches:
            print(f"No DIDs matching '{args.search}'")
            return 1
        print(f"Found {len(matches)} DID(s) matching '{args.search}':\n")
        for e in matches:
            print(d.format_entry(e))
            print()
        return 0
    
    if args.scope:
        matches = d.list_by_scope(args.scope)
        if not matches:
            print(f"No DIDs in scope '{args.scope}'. Available scopes:")
            for s in d.list_all_scopes():
                print(f"  {s}")
            return 1
        print(f"DIDs in scope '{args.scope}' ({len(matches)} entries):\n")
        for e in sorted(matches, key=lambda x: (x['did_id'], x['byte_pos'])):
            print(d.format_entry(e))
            print()
        return 0
    
    if args.did:
        entries = d._by_id.get(args.did, [])
        if not entries:
            # Try alternate forms (strip 0x, zero-pad)
            for form in [args.did.lstrip('0x'), args.did.zfill(5), f'0{args.did}'[-5:]]:
                if form in d._by_id:
                    entries = d._by_id[form]
                    break
        if not entries:
            print(f"No DID '{args.did}' in database")
            return 1
        if args.byte is not None and args.value is not None:
            # Decode specific value
            result = d.decode_value(args.did, args.byte, args.value)
            if result:
                print(f"DID {args.did} byte {args.byte} value {args.value}:")
                print(f"  {result['description']}: {result['meaning']}")
                if result['scope']:
                    print(f"  scope: {result['scope']}")
            else:
                print(f"No decoder for DID {args.did} byte {args.byte}")
            return 0
        # List all entries for this DID
        print(f"DID {args.did} has {len(entries)} byte position(s):\n")
        for e in sorted(entries, key=lambda x: x['byte_pos']):
            print(d.format_entry(e))
            print()
        return 0
    
    if args.all:
        for e in sorted(d.dids, key=lambda x: (x['did_id'], x['byte_pos'])):
            print(d.format_entry(e))
            print()
        return 0
    
    ap.print_help()
    return 0


if __name__ == '__main__':
    sys.exit(main())
