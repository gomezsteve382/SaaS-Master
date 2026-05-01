"""
Catalog assertions for Task #499.

Validates ``unlock_catalog.json`` and the live python-bridge dispatcher
(``srtlab_unlock_catalog``) against the same invariants the SRT Lab UI
relies on:

  * every DLL in ``canflash_unlocks/`` is catalogued
  * every reversed entry's ``python_function`` is importable and callable
  * every dll_only entry has a non-empty ``reason``
  * every CAN id (when present) fits in 11 bits (0x000..0x7FF)
  * the on-disk catalog is in sync with what the generator would emit
    (drift check via ``--check`` mode)
  * the dispatcher's MODULE_INFO derived view matches the catalog 1:1

Run:
    python3 -m unittest tools/python-bridge/tools/test_unlock_catalog.py

or directly:
    python3 tools/python-bridge/tools/test_unlock_catalog.py
"""

import json
import os
import re
import subprocess
import sys
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)

CATALOG_PATH = os.path.join(HERE, 'unlock_catalog.json')
DLL_DIR = os.path.join(HERE, 'canflash_unlocks')
GENERATOR_PATH = os.path.join(HERE, 'srtlab_unlock_catalog_gen.py')


def load_catalog():
    with open(CATALOG_PATH, 'r', encoding='utf-8') as f:
        return json.load(f)


class CatalogShape(unittest.TestCase):
    def setUp(self):
        self.cat = load_catalog()
        self.entries = self.cat['entries']

    def test_schema_version(self):
        self.assertEqual(self.cat['schema_version'], 1)

    def test_every_dll_is_catalogued(self):
        on_disk = sorted(
            f for f in os.listdir(DLL_DIR) if f.lower().endswith('.dll')
        )
        in_catalog = sorted(e['file'] for e in self.entries)
        self.assertEqual(
            in_catalog, on_disk,
            'unlock_catalog.json is missing DLLs (or has stale ones); '
            'regenerate with python3 srtlab_unlock_catalog_gen.py',
        )

    def test_counts_consistent(self):
        self.assertEqual(self.cat['entry_count'], len(self.entries))
        self.assertEqual(
            self.cat['reversed_count'] + self.cat['dll_only_count'],
            self.cat['entry_count'],
        )
        rev = sum(1 for e in self.entries if e['status'] == 'reversed')
        ddo = sum(1 for e in self.entries if e['status'] == 'dll_only')
        self.assertEqual(rev, self.cat['reversed_count'])
        self.assertEqual(ddo, self.cat['dll_only_count'])

    def test_modules_unique(self):
        mods = [e['module'] for e in self.entries]
        self.assertEqual(len(mods), len(set(mods)), 'duplicate modules')

    def test_can_ids_are_11_bit(self):
        for e in self.entries:
            for field in ('tx_can_id', 'rx_can_id'):
                v = e.get(field)
                if v is None:
                    continue
                self.assertIsInstance(v, int)
                self.assertTrue(
                    0 <= v <= 0x7FF,
                    f'{e["module"]}.{field} = 0x{v:X} outside 11-bit CAN range',
                )

    def test_reversed_entries_have_python_function(self):
        ident = re.compile(r'^[A-Za-z_][A-Za-z0-9_]*$')
        for e in self.entries:
            if e['status'] != 'reversed':
                continue
            self.assertIsInstance(
                e.get('python_function'), str,
                f'{e["module"]} reversed but python_function is null',
            )
            self.assertTrue(
                ident.match(e['python_function']),
                f'{e["module"]} python_function {e["python_function"]!r} not a valid identifier',
            )

    def test_dll_only_entries_have_reason(self):
        for e in self.entries:
            if e['status'] != 'dll_only':
                continue
            reason = e.get('reason')
            self.assertIsInstance(
                reason, str,
                f'{e["module"]} dll_only but reason is null',
            )
            self.assertTrue(
                reason.strip(),
                f'{e["module"]} dll_only but reason is empty',
            )

    def test_ecu_info_decoded_for_all(self):
        failed = [e['module'] for e in self.entries if e['ecu_info'].get('decode_failed')]
        self.assertEqual(failed, [], f'{len(failed)} entries failed ecu_info decode: {failed}')


class CatalogVsGenerator(unittest.TestCase):
    def test_generator_check_mode_passes(self):
        """The generator's --check mode confirms the on-disk JSON is fresh."""
        result = subprocess.run(
            [sys.executable, GENERATOR_PATH, '--check'],
            capture_output=True, text=True,
        )
        self.assertEqual(
            result.returncode, 0,
            f'generator --check reports drift:\nstdout:\n{result.stdout}\nstderr:\n{result.stderr}',
        )


class DispatcherIntegration(unittest.TestCase):
    def setUp(self):
        # Importing the dispatcher exercises the catalog-driven loaders.
        import srtlab_unlock_catalog as suc
        self.suc = suc
        self.cat = load_catalog()

    def test_module_info_matches_catalog(self):
        cat_mods = {e['module'] for e in self.cat['entries']}
        self.assertEqual(set(self.suc.MODULE_INFO), cat_mods)

    def test_native_count_matches_catalog_reversed(self):
        # Every reversed entry's python_function MUST be importable + callable
        # via the dispatcher's NATIVE table. (This is the core "function
        # importability" assertion.)
        missing = []
        for e in self.cat['entries']:
            if e['status'] != 'reversed':
                continue
            fn = self.suc.NATIVE.get(e['module'])
            if fn is None or not callable(fn):
                missing.append((e['module'], e['python_function']))
        self.assertEqual(
            missing, [],
            f'{len(missing)} reversed entries lack a callable Python port: {missing}',
        )
        self.assertEqual(self.suc.native_count(), self.cat['reversed_count'])
        self.assertEqual(self.suc.emulated_count(), self.cat['dll_only_count'])

    def test_unlock_dispatch_for_all_reversed_entries(self):
        """Calling unlock(..., prefer_native=True) on every reversed entry
        returns a 32-bit integer without raising. Confirms the dispatcher's
        function-resolution path is wired end-to-end."""
        SEED = 0xDEADBEEF
        failures = []
        for e in self.cat['entries']:
            if e['status'] != 'reversed':
                continue
            try:
                k = self.suc.unlock(e['module'], SEED, prefer_native=True)
            except Exception as exc:  # noqa: BLE001
                failures.append((e['module'], type(exc).__name__, str(exc)))
                continue
            if not isinstance(k, int) or k < 0 or k > 0xFFFFFFFF:
                failures.append((e['module'], 'BadResult', repr(k)))
        self.assertEqual(failures, [], f'unlock() failed for: {failures}')


if __name__ == '__main__':
    unittest.main(verbosity=2)
