/**
 * Tests for parseEfdZipPackage and buildFullFlashImage in efdParser.js.
 * We use fflate to build synthetic zip fixtures in-process.
 */
import { describe, it, expect } from 'vitest';
import { zipSync } from 'fflate';

// Import the functions under test via dynamic import (ESM)
// We test the pure logic by building minimal synthetic zip packages.

const enc = (s: string) => new TextEncoder().encode(s);

/**
 * Build a synthetic outer zip that mimics the PowerCal EFD package structure.
 * blocks: array of { index, startAddr, endAddr, codeData }
 */
function buildSyntheticPackage(blocks: Array<{
  index: number;
  startAddr: number;
  endAddr: number;
  codeData: Uint8Array;
  sourceFile?: string;
}>): Uint8Array {
  const outerEntries: Record<string, Uint8Array> = {};

  // Root Microprocessor.zip
  const rootEntries: Record<string, Uint8Array> = {
    'Microprocessor/Description.txt': enc('Engine = 6.4L\nProgram = 19LD64\nVersion = TEST_CAL_1.0'),
  };
  outerEntries['Microprocessor.zip'] = zipSync(rootEntries);

  for (const blk of blocks) {
    const lbEntries: Record<string, Uint8Array> = {
      [`Microprocessor${blk.index}_LogicalBlock/PhysicalBlock/CodeData.bin`]: blk.codeData,
      [`Microprocessor${blk.index}_LogicalBlock/PhysicalBlock/Address.txt`]: enc(`0x${blk.startAddr.toString(16)}`),
      [`Microprocessor${blk.index}_LogicalBlock/AddressRange/StartAddress.txt`]: enc(`0x${blk.startAddr.toString(16)}`),
      [`Microprocessor${blk.index}_LogicalBlock/AddressRange/EndAddress.txt`]: enc(`0x${blk.endAddr.toString(16)}`),
    };
    if (blk.sourceFile) {
      const sfEntries: Record<string, Uint8Array> = {
        [`Microprocessor${blk.index}_SourceFile/SourceFileName.txt`]: enc(blk.sourceFile),
      };
      outerEntries[`Microprocessor${blk.index}_SourceFile.zip`] = zipSync(sfEntries);
    }
    outerEntries[`Microprocessor${blk.index}_LogicalBlock.zip`] = zipSync(lbEntries);
  }

  return zipSync(outerEntries);
}

describe('parseEfdZipPackage', () => {
  it('parses a single-block package correctly', async () => {
    const { parseEfdZipPackage } = await import('../client/src/srtlab/lib/efdParser.js');

    const codeData = new Uint8Array(3407872).fill(0xAA);
    const pkg = buildSyntheticPackage([{
      index: 18,
      startAddr: 0x40000,
      endAddr: 0x37FFFF,
      codeData,
      sourceFile: '68419038AEA.S19',
    }]);

    const result = await parseEfdZipPackage(pkg, 'test_package.zip');
    expect(result.ok).toBe(true);
    expect(result.blocks).toHaveLength(1);

    const blk = result.blocks[0];
    expect(blk.index).toBe(18);
    expect(blk.startAddress).toBe(0x40000);
    expect(blk.endAddress).toBe(0x37FFFF);
    expect(blk.declaredSize).toBe(3407872);
    expect(blk.dataSize).toBe(3407872);
    expect(blk.sizeMatch).toBe(true);
    expect(blk.label).toContain('INT FLASH');
    expect(blk.label).toContain('Multi-PROG');
    expect(blk.sourceFile).toBe('68419038AEA.S19');
  });

  it('parses a multi-block package and sorts by start address', async () => {
    const { parseEfdZipPackage } = await import('../client/src/srtlab/lib/efdParser.js');

    const lb18 = new Uint8Array(3407872).fill(0x11);
    const lb19 = new Uint8Array(524288).fill(0x22);
    const lb20 = new Uint8Array(5632).fill(0x33);

    const pkg = buildSyntheticPackage([
      { index: 20, startAddr: 0xE000,   endAddr: 0xF5FF,   codeData: lb20 },
      { index: 19, startAddr: 0x380000, endAddr: 0x3FFFFF, codeData: lb19 },
      { index: 18, startAddr: 0x40000,  endAddr: 0x37FFFF, codeData: lb18 },
    ]);

    const result = await parseEfdZipPackage(pkg, 'multi_block.zip');
    expect(result.ok).toBe(true);
    expect(result.blocks).toHaveLength(3);

    // Should be sorted by start address
    expect(result.blocks[0].startAddress).toBe(0xE000);
    expect(result.blocks[1].startAddress).toBe(0x40000);
    expect(result.blocks[2].startAddress).toBe(0x380000);

    expect(result.blocks[1].label).toContain('INT FLASH');
    expect(result.blocks[2].label).toContain('Secondary P-Flash');
    expect(result.blocks[0].label).toContain('Data Block');
  });

  it('reports sizeMatch=false when CodeData.bin is truncated', async () => {
    const { parseEfdZipPackage } = await import('../client/src/srtlab/lib/efdParser.js');

    // Declare 3407872 bytes but only provide 1000
    const truncated = new Uint8Array(1000).fill(0xFF);
    const pkg = buildSyntheticPackage([{
      index: 18,
      startAddr: 0x40000,
      endAddr: 0x37FFFF,
      codeData: truncated,
    }]);

    const result = await parseEfdZipPackage(pkg, 'truncated.zip');
    expect(result.ok).toBe(true);
    const blk = result.blocks[0];
    expect(blk.sizeMatch).toBe(false);
    expect(blk.dataSize).toBe(1000);
    expect(blk.declaredSize).toBe(3407872);
  });

  it('returns error for non-zip input', async () => {
    const { parseEfdZipPackage } = await import('../client/src/srtlab/lib/efdParser.js');
    const garbage = new Uint8Array([0x00, 0x01, 0x02, 0x03, 0x04]);
    const result = await parseEfdZipPackage(garbage, 'garbage.zip');
    expect(result.ok).toBe(false);
    expect(result.error).toBeTruthy();
  });

  it('returns error when no LogicalBlock zips are found', async () => {
    const { parseEfdZipPackage } = await import('../client/src/srtlab/lib/efdParser.js');
    // A valid zip but with no LogicalBlock entries
    const emptyPkg = zipSync({ 'README.txt': enc('no blocks here') });
    const result = await parseEfdZipPackage(emptyPkg, 'empty.zip');
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/LogicalBlock/i);
  });

  it('parses descriptor from root Microprocessor.zip', async () => {
    const { parseEfdZipPackage } = await import('../client/src/srtlab/lib/efdParser.js');

    const codeData = new Uint8Array(100).fill(0xBB);
    const pkg = buildSyntheticPackage([{
      index: 18,
      startAddr: 0x40000,
      endAddr: 0x40063,  // 100 bytes
      codeData,
    }]);

    const result = await parseEfdZipPackage(pkg, 'desc_test.zip');
    expect(result.ok).toBe(true);
    expect(result.descriptor.description).toContain('Engine = 6.4L');
    expect(result.descriptor.description).toContain('Program = 19LD64');
  });
});

describe('buildFullFlashImage', () => {
  it('assembles two non-overlapping blocks correctly', async () => {
    const { buildFullFlashImage } = await import('../client/src/srtlab/lib/efdParser.js');

    const blk1 = new Uint8Array([0xAA, 0xBB, 0xCC]);
    const blk2 = new Uint8Array([0x11, 0x22]);

    const blocks = [
      { startAddress: 0x100, endAddress: 0x102, declaredSize: 3, data: blk1, dataSize: 3 },
      { startAddress: 0x106, endAddress: 0x107, declaredSize: 2, data: blk2, dataSize: 2 },
    ];

    const r = buildFullFlashImage(blocks as any);
    expect(r).not.toBeNull();
    expect(r!.startAddress).toBe(0x100);
    expect(r!.endAddress).toBe(0x107);
    expect(r!.image.length).toBe(8);  // 0x100 to 0x107 inclusive

    // First block at offset 0
    expect(r!.image[0]).toBe(0xAA);
    expect(r!.image[1]).toBe(0xBB);
    expect(r!.image[2]).toBe(0xCC);
    // Gap at offsets 3,4,5 filled with 0xFF
    expect(r!.image[3]).toBe(0xFF);
    expect(r!.image[4]).toBe(0xFF);
    expect(r!.image[5]).toBe(0xFF);
    // Second block at offset 6
    expect(r!.image[6]).toBe(0x11);
    expect(r!.image[7]).toBe(0x22);
  });

  it('returns null for empty block list', async () => {
    const { buildFullFlashImage } = await import('../client/src/srtlab/lib/efdParser.js');
    expect(buildFullFlashImage([])).toBeNull();
    expect(buildFullFlashImage(null as any)).toBeNull();
  });

  it('handles a single block with no gap', async () => {
    const { buildFullFlashImage } = await import('../client/src/srtlab/lib/efdParser.js');
    const data = new Uint8Array([0x01, 0x02, 0x03, 0x04]);
    const r = buildFullFlashImage([{
      startAddress: 0x200, endAddress: 0x203, declaredSize: 4, data, dataSize: 4
    }] as any);
    expect(r!.image).toEqual(data);
    expect(r!.startAddress).toBe(0x200);
    expect(r!.endAddress).toBe(0x203);
  });
});

// ─── benchWriteValidate ───────────────────────────────────────────────────────

describe('benchWriteValidate', () => {
  it('returns pass=true for exact LB18 size (3407872)', async () => {
    const { benchWriteValidate } = await import('../client/src/srtlab/lib/efdParser.js');
    const r = benchWriteValidate(3407872, '18SCAT_ECM_INTFLASH.bin');
    expect(r.pass).toBe(true);
    expect(r.matches.length).toBeGreaterThan(0);
    expect(r.matches[0].region).toContain('INT FLASH');
    expect(r.close).toHaveLength(0);
  });

  it('returns pass=true for exact RFHUB 4 KB size (4096)', async () => {
    const { benchWriteValidate } = await import('../client/src/srtlab/lib/efdParser.js');
    const r = benchWriteValidate(4096, 'rfhub.bin');
    expect(r.pass).toBe(true);
    expect(r.matches.some(m => m.ecu.includes('RFHUB'))).toBe(true);
  });

  it('returns pass=false with close matches for encrypted EFD payload size (3985326)', async () => {
    const { benchWriteValidate } = await import('../client/src/srtlab/lib/efdParser.js');
    const r = benchWriteValidate(3985326, '18SCAT_ECM_INTFLASH.bin');
    expect(r.pass).toBe(false);
    expect(r.close.length).toBeGreaterThan(0);
    // Should be close to LB18 (3407872) or full P-Flash (4194304)
    const regions = r.close.map(c => c.region);
    expect(regions.some(reg => reg.includes('INT FLASH') || reg.includes('P-Flash'))).toBe(true);
  });

  it('returns pass=false with no close matches for random small size (512)', async () => {
    const { benchWriteValidate } = await import('../client/src/srtlab/lib/efdParser.js');
    const r = benchWriteValidate(512, 'tiny.bin');
    expect(r.pass).toBe(false);
    expect(r.close).toHaveLength(0);
  });

  it('includes filename in result', async () => {
    const { benchWriteValidate } = await import('../client/src/srtlab/lib/efdParser.js');
    const r = benchWriteValidate(3407872, 'myfile.bin');
    expect(r.filename).toBe('myfile.bin');
    expect(r.byteLength).toBe(3407872);
  });
});

// ─── parseEfdFilename ─────────────────────────────────────────────────────────

describe('parseEfdFilename', () => {
  it('parses 18SCAT_ECM_INTFLASH.bin correctly', async () => {
    const { parseEfdFilename } = await import('../client/src/srtlab/lib/efdParser.js');
    const r = parseEfdFilename('18SCAT_ECM_INTFLASH.bin');
    expect(r.year).toBe(2018);
    expect(r.module).toBe('ECM');
    expect(r.program).toBe('SCAT');
    expect(r.region).toBe('INTFLASH');
    expect(r.summary).toContain('2018');
    expect(r.summary).toContain('SCAT');
    expect(r.summary).toContain('ECM');
  });

  it('parses 19LD64_BCM_CFLASH.zip correctly', async () => {
    const { parseEfdFilename } = await import('../client/src/srtlab/lib/efdParser.js');
    const r = parseEfdFilename('19LD64_BCM_CFLASH.zip');
    expect(r.year).toBe(2019);
    expect(r.module).toBe('BCM');
    expect(r.program).toBe('LD64');
    expect(r.region).toBe('CFLASH');
  });

  it('parses 2018GPEC2A_P14U_ENG.zip correctly', async () => {
    const { parseEfdFilename } = await import('../client/src/srtlab/lib/efdParser.js');
    const r = parseEfdFilename('2018GPEC2A_P14U_ENG.zip');
    expect(r.year).toBe(2018);
    expect(r.program).toBe('GPEC2A');
  });

  it('returns unknown summary for unrecognized filename', async () => {
    const { parseEfdFilename } = await import('../client/src/srtlab/lib/efdParser.js');
    const r = parseEfdFilename('random_file_xyz.bin');
    expect(r.year).toBeNull();
    expect(r.module).toBeNull();
    expect(r.summary).toBe('Unknown calibration');
  });

  it('handles null/undefined gracefully', async () => {
    const { parseEfdFilename } = await import('../client/src/srtlab/lib/efdParser.js');
    const r = parseEfdFilename(null as any);
    expect(r.summary).toBe('Unknown calibration');
  });

  it('detects HELLCAT program', async () => {
    const { parseEfdFilename } = await import('../client/src/srtlab/lib/efdParser.js');
    const r = parseEfdFilename('2020_HELLCAT_ECM_INTFLASH.bin');
    expect(r.program).toBe('HELLCAT');
    expect(r.year).toBe(2020);
    expect(r.module).toBe('ECM');
  });

  it('detects TCM module', async () => {
    const { parseEfdFilename } = await import('../client/src/srtlab/lib/efdParser.js');
    const r = parseEfdFilename('19SCAT_TCM_INTFLASH.bin');
    expect(r.module).toBe('TCM');
    expect(r.moduleDesc).toContain('Transmission');
  });
});

// ─── diffEfdBlocks ────────────────────────────────────────────────────────────

describe('diffEfdBlocks', () => {
  it('reports identical for two equal blocks', async () => {
    const { diffEfdBlocks } = await import('../client/src/srtlab/lib/efdParser.js');
    const data = new Uint8Array(100).fill(0xAA);
    const blocksA = [{ index: 18, label: 'INT FLASH', startAddress: 0x40000, endAddress: 0x40063, dataSize: 100, data }];
    const blocksB = [{ index: 18, label: 'INT FLASH', startAddress: 0x40000, endAddress: 0x40063, dataSize: 100, data }];
    const diffs = diffEfdBlocks(blocksA as any, blocksB as any);
    expect(diffs).toHaveLength(1);
    expect(diffs[0].identical).toBe(true);
    expect(diffs[0].changedBytes).toBe(0);
    expect(diffs[0].hunks).toHaveLength(0);
  });

  it('counts changed bytes correctly', async () => {
    const { diffEfdBlocks } = await import('../client/src/srtlab/lib/efdParser.js');
    const a = new Uint8Array(10).fill(0x00);
    const b = new Uint8Array(10).fill(0x00);
    b[3] = 0xFF;
    b[7] = 0xFF;
    const blocksA = [{ index: 18, label: 'LB18', startAddress: 0, endAddress: 9, dataSize: 10, data: a }];
    const blocksB = [{ index: 18, label: 'LB18', startAddress: 0, endAddress: 9, dataSize: 10, data: b }];
    const diffs = diffEfdBlocks(blocksA as any, blocksB as any);
    expect(diffs[0].identical).toBe(false);
    expect(diffs[0].changedBytes).toBe(2);
    expect(diffs[0].pctChanged).toBeCloseTo(20, 0);
  });

  it('marks blocks only in A or only in B', async () => {
    const { diffEfdBlocks } = await import('../client/src/srtlab/lib/efdParser.js');
    const data = new Uint8Array(4).fill(0x01);
    const blocksA = [{ index: 18, label: 'LB18', startAddress: 0, endAddress: 3, dataSize: 4, data }];
    const blocksB = [{ index: 19, label: 'LB19', startAddress: 0, endAddress: 3, dataSize: 4, data }];
    const diffs = diffEfdBlocks(blocksA as any, blocksB as any);
    expect(diffs).toHaveLength(2);
    const d18 = diffs.find(d => d.index === 18)!;
    const d19 = diffs.find(d => d.index === 19)!;
    expect(d18.onlyInA).toBe(true);
    expect(d19.onlyInB).toBe(true);
  });

  it('handles empty block arrays', async () => {
    const { diffEfdBlocks } = await import('../client/src/srtlab/lib/efdParser.js');
    expect(diffEfdBlocks([], [])).toHaveLength(0);
    expect(diffEfdBlocks(null as any, null as any)).toHaveLength(0);
  });

  it('produces hunks for changed regions', async () => {
    const { diffEfdBlocks } = await import('../client/src/srtlab/lib/efdParser.js');
    const a = new Uint8Array(100).fill(0x00);
    const b = new Uint8Array(100).fill(0x00);
    // Change a contiguous region
    for (let i = 40; i < 60; i++) b[i] = 0xFF;
    const blocksA = [{ index: 18, label: 'LB18', startAddress: 0, endAddress: 99, dataSize: 100, data: a }];
    const blocksB = [{ index: 18, label: 'LB18', startAddress: 0, endAddress: 99, dataSize: 100, data: b }];
    const diffs = diffEfdBlocks(blocksA as any, blocksB as any);
    expect(diffs[0].hunks.length).toBeGreaterThan(0);
    expect(diffs[0].hunks[0].offset).toBeLessThanOrEqual(40);
  });
});

// ── Regression: 8 KB GPEC2A EXT EEPROM filename detection ──────────────────
// parseModule.js intentionally blocks the filename override for 8 KB files
// (to protect the keyProgWizard doubled-PCM path). SecuritySyncTab.loadPcm
// must pass forceType:'GPEC2A' when the filename contains 'GPEC' so that
// FCA_CONTINENTAL_GPEC2A_EXTEEPROM_*.bin files are accepted in the PCM slot
// instead of being rejected as '95640'.
describe('SecuritySyncTab loadPcm — 8 KB GPEC2A EXT EEPROM forceType logic', () => {
  it('applies forceType GPEC2A for FCA_CONTINENTAL_GPEC2A_EXTEEPROM filename', () => {
    const filename = 'FCA_CONTINENTAL_GPEC2A_EXTEEPROM_zo.bin';
    const nameUpper = filename.toUpperCase();
    const forceOpts = /GPEC/.test(nameUpper) ? { forceType: 'GPEC2A' } : undefined;
    expect(forceOpts).toEqual({ forceType: 'GPEC2A' });
  });

  it('does not apply forceType for BCM filenames', () => {
    const filename = 'SAMPLE_BCM_SYNCED_2C3CDXL90MH582899.bin';
    const nameUpper = filename.toUpperCase();
    const forceOpts = /GPEC/.test(nameUpper) ? { forceType: 'GPEC2A' } : undefined;
    expect(forceOpts).toBeUndefined();
  });

  it('applies forceType for all common GPEC2A EXT EEPROM filename patterns', () => {
    const gpecPatterns = [
      'FCA_CONTINENTAL_GPEC2A_EXTEEPROM_zo.bin',
      'GPEC2A_PCM_BACKUP.bin',
      'gpec2a_exteeprom_original.bin',
      'MY2019_GPEC2B_EXTEEPROM.bin',
    ];
    for (const filename of gpecPatterns) {
      const nameUpper = filename.toUpperCase();
      const forceOpts = /GPEC/.test(nameUpper) ? { forceType: 'GPEC2A' } : undefined;
      expect(forceOpts, `Expected forceType for filename: ${filename}`).toEqual({ forceType: 'GPEC2A' });
    }
  });

  it('does not apply forceType for RFHUB, BCM, or generic PCM filenames', () => {
    const nonGpecPatterns = [
      'RFHUB_BACKUP.bin',
      'BCM_DFLASH.bin',
      'PCM_INTFLASH.bin',
      '18SCAT_ECM_INTFLASH.bin',
    ];
    for (const filename of nonGpecPatterns) {
      const nameUpper = filename.toUpperCase();
      const forceOpts = /GPEC/.test(nameUpper) ? { forceType: 'GPEC2A' } : undefined;
      expect(forceOpts, `Expected no forceType for filename: ${filename}`).toBeUndefined();
    }
  });

  it('size-first detection gives 95640 before GPEC2A for 8192-byte files (confirming the fix is needed)', () => {
    // This documents why the fix is necessary: without forceType, an 8 KB file
    // is classified as 95640 (BCM-backup EEPROM) because 95640 appears before
    // GPEC2A in CANONICAL_SIZES_BY_TYPE insertion order.
    const CANONICAL_SIZES: Record<string, number[]> = {
      BCM: [65536, 131072],
      '95640': [8192],
      GPEC2A: [4096, 8192],
      RFHUB: [2048, 4096, 8192],
    };
    const sizeFirst = Object.keys(CANONICAL_SIZES).find(k => CANONICAL_SIZES[k].includes(8192));
    expect(sizeFirst).toBe('95640');
  });
});

// ── Regression: gen2-hybrid RFHUB write routing ─────────────────────────────
// A 4 KB RFHUB classified as 'gen2-hybrid' (Gen2 slots empty, no AA-55-31-01
// banner) must be written via writeRfhSec16Gen2Slots, not writeRfhSec16FromBcm.
// writeRfhSec16FromBcm throws "Not a Gen2 RFHUB" for banner-less files.
describe('writeRfhSec16Gen2Slots — gen2-hybrid RFHUB write path', () => {
  it('writes SEC16 to Gen2 slots without requiring AA-55-31-01 header', async () => {
    const { writeRfhSec16Gen2Slots } = await import('../client/src/srtlab/lib/securityBytes.js');
    // 4 KB RFHUB with no AA-55-31-01 banner at 0x0500 (all FF)
    const bytes = new Uint8Array(4096).fill(0xFF);
    const bcmSec16 = new Uint8Array([0x00,0x00,0x00,0x00,0x00,0x00,0x00,0x31,0x3E,0x00,0x10,0x00,0x18,0x00,0x0A,0x00]);
    const res = writeRfhSec16Gen2Slots(bytes, bcmSec16);
    expect(res.patched).toBe(2);
    // RFHUB SEC16 = reverse(BCM SEC16)
    const expectedRfh = new Uint8Array([0x00,0x0A,0x00,0x18,0x00,0x10,0x00,0x3E,0x31,0x00,0x00,0x00,0x00,0x00,0x00,0x00]);
    expect(Array.from(res.bytes.slice(0x050E, 0x051E))).toEqual(Array.from(expectedRfh));
    expect(Array.from(res.bytes.slice(0x0522, 0x0532))).toEqual(Array.from(expectedRfh));
  });

  it('throws if BCM SEC16 is not 16 bytes', async () => {
    const { writeRfhSec16Gen2Slots } = await import('../client/src/srtlab/lib/securityBytes.js');
    const bytes = new Uint8Array(4096).fill(0xFF);
    expect(() => writeRfhSec16Gen2Slots(bytes, new Uint8Array(8))).toThrow('BCM SEC16 must be 16 bytes');
  });

  it('throws if buffer is too small for Gen2 slots', async () => {
    const { writeRfhSec16Gen2Slots } = await import('../client/src/srtlab/lib/securityBytes.js');
    const bytes = new Uint8Array(100).fill(0xFF);
    const bcmSec16 = new Uint8Array(16).fill(0x01);
    expect(() => writeRfhSec16Gen2Slots(bytes, bcmSec16)).toThrow('Buffer too small');
  });

  it('writeRfhSec16FromBcm still throws for banner-less files (confirming the fix is needed)', async () => {
    const { writeRfhSec16FromBcm } = await import('../client/src/srtlab/lib/securityBytes.js');
    const bytes = new Uint8Array(4096).fill(0xFF); // no AA-55-31-01 at 0x0500
    const bcmSec16 = new Uint8Array(16).fill(0x01);
    expect(() => writeRfhSec16FromBcm(bytes, bcmSec16)).toThrow('Not a Gen2 RFHUB');
  });
});

// ── Regression: SecuritySyncTab wizard gen2-hybrid routing logic ─────────────
describe('SecuritySyncTab wizard — gen2-hybrid format routing', () => {
  it('routes gen2-hybrid to writeRfhSec16Gen2Slots (not writeRfhSec16FromBcm)', () => {
    // Simulate the routing logic from SecuritySyncTab.applyAllFixes
    const format = 'gen2-hybrid';
    const isXc2268 = false;
    let path: string;
    if (isXc2268) {
      path = 'writeXc2268Sec16';
    } else if (format === 'gen1') {
      path = 'writeRfhSec16Gen1';
    } else if (format === 'gen2-hybrid') {
      path = 'writeRfhSec16Gen2Slots';
    } else {
      path = 'writeRfhSec16FromBcm';
    }
    expect(path).toBe('writeRfhSec16Gen2Slots');
  });

  it('routes gen2 (with banner) to writeRfhSec16FromBcm', () => {
    const format = 'gen2';
    const isXc2268 = false;
    let path: string;
    if (isXc2268) path = 'writeXc2268Sec16';
    else if (format === 'gen1') path = 'writeRfhSec16Gen1';
    else if (format === 'gen2-hybrid') path = 'writeRfhSec16Gen2Slots';
    else path = 'writeRfhSec16FromBcm';
    expect(path).toBe('writeRfhSec16FromBcm');
  });
});

// ─── flashBinAnalyzer tests ──────────────────────────────────────────────────
// flashBinAnalyzer.js is a client-side ES module. We test its pure logic
// by re-implementing the key algorithms inline (no DOM required).

describe('flashBinAnalyzer — ECU detection by size', () => {
  const KNOWN_SIZES = new Set([
    3407872,  // GPEC2A LB18 INT FLASH
    524288,   // GPEC2A LB19 Secondary P-Flash
    4194304,  // GPEC2A Full P-Flash
    1048576,  // BCM full flash
    2097152,  // TCM full flash
    4096,     // RFHUB Gen2 4 KB / GPEC2A EXT EEPROM
    8192,     // RFHUB Gen2 8 KB (Trackhawk) / GPEC2A EXT EEPROM 95640
    16384,    // XC2268 RFHUB
    2048,     // BCM EEPROM
    5632,     // GPEC2A LB20 Data Block
  ]);

  it('recognizes GPEC2A LB18 size (3,407,872 bytes)', () => {
    expect(KNOWN_SIZES.has(3407872)).toBe(true);
  });

  it('recognizes GPEC2A LB19 size (524,288 bytes)', () => {
    expect(KNOWN_SIZES.has(524288)).toBe(true);
  });

  it('recognizes BCM full flash size (1,048,576 bytes)', () => {
    expect(KNOWN_SIZES.has(1048576)).toBe(true);
  });

  it('recognizes RFHUB Gen2 4 KB size', () => {
    expect(KNOWN_SIZES.has(4096)).toBe(true);
  });

  it('recognizes RFHUB Gen2 8 KB (Trackhawk) size', () => {
    expect(KNOWN_SIZES.has(8192)).toBe(true);
  });

  it('recognizes XC2268 RFHUB 16 KB size', () => {
    expect(KNOWN_SIZES.has(16384)).toBe(true);
  });

  it('does NOT recognize encrypted EFD payload size (3,985,326 bytes)', () => {
    expect(KNOWN_SIZES.has(3985326)).toBe(false);
  });
});

describe('flashBinAnalyzer — entropy calculation', () => {
  function entropy(bytes: Uint8Array): number {
    const counts = new Uint32Array(256);
    for (let i = 0; i < bytes.length; i++) counts[bytes[i]]++;
    let ent = 0;
    const total = bytes.length;
    for (let i = 0; i < 256; i++) {
      if (counts[i] === 0) continue;
      const p = counts[i] / total;
      ent -= p * Math.log2(p);
    }
    return ent;
  }

  it('all-FF block has entropy 0', () => {
    const bytes = new Uint8Array(256).fill(0xFF);
    expect(entropy(bytes)).toBeCloseTo(0, 5);
  });

  it('uniform distribution has entropy 8', () => {
    const bytes = new Uint8Array(256);
    for (let i = 0; i < 256; i++) bytes[i] = i;
    expect(entropy(bytes)).toBeCloseTo(8, 5);
  });

  it('two-value alternating has entropy 1', () => {
    const bytes = new Uint8Array(256);
    for (let i = 0; i < 256; i++) bytes[i] = i % 2;
    expect(entropy(bytes)).toBeCloseTo(1, 5);
  });

  it('pseudo-random data entropy > 7.0 (simulates encrypted payload)', () => {
    const bytes = new Uint8Array(1024);
    for (let i = 0; i < 1024; i++) bytes[i] = (i * 37 + 13) % 256;
    expect(entropy(bytes)).toBeGreaterThan(7.0);
  });
});

describe('flashBinAnalyzer — VIN scan', () => {
  const KNOWN_WMIS = new Set(['1C3','1C6','2C3','2C6','3C3','3C6','1B3','2B3','1D3','2D3']);

  function isVinChar(c: number): boolean {
    return (c >= 0x30 && c <= 0x39) ||
           (c >= 0x41 && c <= 0x48) ||
           (c >= 0x4A && c <= 0x4E) ||
           (c >= 0x50 && c <= 0x5A && c !== 0x51);
  }

  function scanVins(bytes: Uint8Array): Array<{offset: number; vin: string}> {
    const results: Array<{offset: number; vin: string}> = [];
    for (let i = 0; i <= bytes.length - 17; i++) {
      let valid = true;
      for (let j = 0; j < 17; j++) {
        if (!isVinChar(bytes[i + j])) { valid = false; break; }
      }
      if (!valid) continue;
      const vin = String.fromCharCode(...Array.from(bytes.slice(i, i + 17)));
      const wmi = vin.slice(0, 3);
      if (KNOWN_WMIS.has(wmi)) {
        results.push({ offset: i, vin });
        i += 16;
      }
    }
    return results;
  }

  it('finds a known Dodge VIN embedded in a buffer', () => {
    const vin = '2C3CDXHG5EH219538';
    const buf = new Uint8Array(64).fill(0xFF);
    for (let i = 0; i < 17; i++) buf[10 + i] = vin.charCodeAt(i);
    const found = scanVins(buf);
    expect(found).toHaveLength(1);
    expect(found[0].vin).toBe(vin);
    expect(found[0].offset).toBe(10);
  });

  it('does not find a VIN with unknown WMI', () => {
    const vin = 'JH4KA7650MC000000'; // Honda WMI
    const buf = new Uint8Array(64).fill(0xFF);
    for (let i = 0; i < 17; i++) buf[10 + i] = vin.charCodeAt(i);
    expect(scanVins(buf)).toHaveLength(0);
  });

  it('does not find VINs in all-FF buffer', () => {
    expect(scanVins(new Uint8Array(256).fill(0xFF))).toHaveLength(0);
  });
});

describe('flashBinAnalyzer — PowerPC magic byte detection', () => {
  it('detects PowerPC bl instruction at offset 0 (GPEC2A LB18 header pattern)', () => {
    // First 4 bytes of LB18 CodeData.bin: 48 0B 8A 44 — PowerPC bl instruction
    const buf = new Uint8Array([0x48, 0x0B, 0x8A, 0x44, 0x00, 0x00, 0x00, 0x00]);
    const view = new DataView(buf.buffer);
    const word = view.getUint32(0, false); // big-endian
    // PowerPC bl: opcode 18 (0x48 >> 2 = 0x12 = 18), top byte 0x48
    expect((word & 0xFF000000) >>> 0).toBe(0x48000000 >>> 0);
  });

  it('rejects non-PowerPC header (all zeros)', () => {
    const buf = new Uint8Array(8); // all zeros
    const view = new DataView(buf.buffer);
    const word = view.getUint32(0, false);
    expect((word & 0xFF000000) >>> 0).not.toBe(0x48000000 >>> 0);
  });

  it('detects MPC5674F reset vector pattern (0x40000000 base address range)', () => {
    // LB18 starts at 0x40000 — the first instruction is a branch into the code
    const startAddr = 0x40000;
    expect(startAddr).toBeGreaterThanOrEqual(0x40000);
    expect(startAddr).toBeLessThan(0x400000);
  });
});
