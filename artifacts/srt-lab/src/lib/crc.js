function crc16(d,i=0xFFFF){let c=i;for(let x=0;x<d.length;x++){c^=d[x]<<8;for(let j=0;j<8;j++)c=c&0x8000?(c<<1)^0x1021:c<<1;c&=0xFFFF;}return c;}
function crc8_42(d){let c=0x2E;for(let x=0;x<d.length;x++){c^=d[x];for(let j=0;j<8;j++)c=c&0x80?((c<<1)^0x42)&0xFF:(c<<1)&0xFF;}return c;}
function crc8rf(d){let c=0x54;for(let x=0;x<d.length;x++){c^=d[x];for(let j=0;j<8;j++)c=c&1?((c>>1)^0xA0):c>>1;}return c&0xFF;}

// Gen2 RFH VIN checksum: XOR all 17 raw stored bytes then XOR with magic.
// Magic varies by RFHUB variant: 0xDB confirmed on 2020 Redeye, 0x87 on earlier Gen2.
// AUTO-DETECT: pass storedCs from any valid slot to derive the correct magic automatically.
const RFH_GEN2_VIN_CS_KNOWN_MAGICS = [0xDB, 0x87];

// rfhGen2VinCs(raw17, magic): compute VIN CS; magic defaults to 0xDB (2020+ Redeye).
// Callers should auto-detect magic via rfhGen2DetectMagic() before validating all slots.
function rfhGen2VinCs(raw17, magic = 0xDB) {
  return Array.from(raw17).reduce((a, b) => a ^ b, 0) ^ magic;
}

// Derive the magic constant from a file's first VIN slot for use in writes
function rfhGen2DetectMagic(raw17, storedCs) {
  const xorAll = Array.from(raw17).reduce((a, b) => a ^ b, 0);
  return storedCs ^ xorAll;
}

// Gen2 RFH SEC16 checksum: CRC8(poly=0x65, init=0xBF, no-reflect, no-xorOut) of 16 data bytes.
// byte[0] (off+16) = CRC8 result; byte[1] (off+17) = 0x00 always.
// Returns the 2-byte big-endian CS as a single 16-bit integer (matches (data[off+16]<<8)|data[off+17]).
function crc8_65(d){let c=0xBF;for(let x=0;x<d.length;x++){c^=d[x];for(let j=0;j<8;j++)c=c&0x80?((c<<1)^0x65)&0xFF:(c<<1)&0xFF;}return c;}
function rfhSec16Cs(raw16){return(crc8_65(Array.from(raw16))<<8)|0x00;}

export {crc16,crc8_42,crc8rf,crc8_65,rfhGen2VinCs,rfhGen2DetectMagic,RFH_GEN2_VIN_CS_KNOWN_MAGICS,rfhSec16Cs};
