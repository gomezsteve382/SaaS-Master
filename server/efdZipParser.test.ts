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
