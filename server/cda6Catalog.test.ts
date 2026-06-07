import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';

// Test the generated CDA6 catalog file directly (Node-compatible import)
const catalogPath = resolve(__dirname, '../client/src/srtlab/lib/ecuCatalogFromCda6.generated.js');
const catalogSrc = readFileSync(catalogPath, 'utf-8');

describe('CDA6 ECU Catalog (ecuCatalogFromCda6.generated.js)', () => {
  it('exports ECU_CATALOG_CDA6 with 398 entries', () => {
    // Extract only the array content between ECU_CATALOG_CDA6 = [ and ];
    const arrayStart = catalogSrc.indexOf('export const ECU_CATALOG_CDA6 = [');
    const arrayEnd = catalogSrc.indexOf('];', arrayStart);
    const arrayContent = catalogSrc.slice(arrayStart, arrayEnd + 2);
    const matches = arrayContent.match(/\{id:\d+,name:/g);
    expect(matches).not.toBeNull();
    expect(matches!.length).toBe(398);
  });

  it('exports ECU_CATALOG_CDA6_META with correct ecuCount', () => {
    expect(catalogSrc).toContain('ecuCount: 398');
  });

  it('includes BCM, ECM, ABS, IPC modules', () => {
    expect(catalogSrc).toContain('"BCM"');
    expect(catalogSrc).toContain('"ECM"');
    expect(catalogSrc).toContain('"ABS"');
    expect(catalogSrc).toContain('"IPC"');
  });

  it('includes protocol fields for some entries', () => {
    expect(catalogSrc).toContain('protocol:');
  });

  it('includes transport fields for some entries', () => {
    expect(catalogSrc).toContain('transport:');
  });

  it('exports findCda6Ecu function', () => {
    expect(catalogSrc).toContain('export function findCda6Ecu');
  });

  it('exports getCda6EcuByAcronym function', () => {
    expect(catalogSrc).toContain('export function getCda6EcuByAcronym');
  });
});

describe('ecuToCanIndex.js re-exports', () => {
  const indexPath = resolve(__dirname, '../client/src/srtlab/lib/ecuToCanIndex.js');
  const indexSrc = readFileSync(indexPath, 'utf-8');

  it('re-exports ECU_CATALOG_CDA6 from ecuCatalogFromCda6.generated.js', () => {
    expect(indexSrc).toContain('ECU_CATALOG_CDA6');
    expect(indexSrc).toContain('ecuCatalogFromCda6.generated.js');
  });

  it('re-exports ECU_CATALOG_CDA6_META', () => {
    expect(indexSrc).toContain('ECU_CATALOG_CDA6_META');
  });
});
