function crc16(d,i=0xFFFF){let c=i;for(let x=0;x<d.length;x++){c^=d[x]<<8;for(let j=0;j<8;j++)c=c&0x8000?(c<<1)^0x1021:c<<1;c&=0xFFFF;}return c;}
function crc8_42(d){let c=0x2E;for(let x=0;x<d.length;x++){c^=d[x];for(let j=0;j<8;j++)c=c&0x80?((c<<1)^0x42)&0xFF:(c<<1)&0xFF;}return c;}
function crc8rf(d){let c=0x54;for(let x=0;x<d.length;x++){c^=d[x];for(let j=0;j<8;j++)c=c&1?((c>>1)^0xA0):c>>1;}return c&0xFF;}

// Gen2 RFH VIN checksum: XOR all 17 raw stored bytes then XOR with magic.
// Magic encodes the VIN storage format:
//   0xDB = VIN stored FORWARD (old tool format, e.g. 2021 Redeye OG files from alpha/6)
//   0xAD = VIN stored REVERSED (standard format, e.g. Sincro/ImmoVIN output)
//   0x87 = VIN stored REVERSED (earlier Gen2 variant)
// When patching: if OG magic == 0xDB (forward-stored), write new VIN REVERSED with magic 0xAD.
// For all other magics (0x87, 0xAD), write REVERSED with the same detected magic.
// AUTO-DETECT: pass storedCs from any valid slot to derive the correct magic automatically.
const RFH_GEN2_VIN_CS_KNOWN_MAGICS = [0xDB, 0xAD, 0x87];
// Magic 0xDB indicates forward-stored VIN (old tool). When writing, switch to 0xAD.
const RFH_GEN2_VIN_MAGIC_FORWARD = 0xDB;
const RFH_GEN2_VIN_MAGIC_REVERSED = 0xAD;

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

/* CRC-16/CCITT-FALSE — production_vin_patcher.py port (poly 0x1021, init 0xFFFF). */
function crc16ccitt(data){
  let crc=0xFFFF;
  for(const b of data){
    crc^=(b<<8);
    for(let i=0;i<8;i++){
      if(crc&0x8000)crc=((crc<<1)^0x1021)&0xFFFF;
      else crc=(crc<<1)&0xFFFF;
    }
  }
  return crc;
}

/* CRC-16 generic — RFHUB VIN-specific poly/init (use with RFHUB_KNOWN_ALGOS). */
function crc16generic(data,poly,init){
  let crc=init;
  for(const b of data){
    crc^=(b<<8);
    for(let i=0;i<8;i++){
      if(crc&0x8000)crc=((crc<<1)^poly)&0xFFFF;
      else crc=(crc<<1)&0xFFFF;
    }
  }
  return crc;
}

const RFHUB_KNOWN_ALGOS={
  '2C3CDXKT3FH796320':{poly:0x589B,init:0xFFFF},
  '2B3CJ4DV6AH300549':{poly:0x8C5B,init:0xFFFF},
  '2B3CJ5DT2BH590794':{poly:0x535D,init:0x0000},
  '2C3CDZFK3HH506737':{poly:0x71DE,init:0x4625},
  '2C3CDZC99HH514330':{poly:0x1189,init:0x0C99},
  '2C3CDXGJ1MH539855':{poly:0x5F08,init:0x0C99},
};

export {crc16,crc8_42,crc8rf,crc8_65,crc16ccitt,crc16generic,RFHUB_KNOWN_ALGOS,rfhGen2VinCs,rfhGen2DetectMagic,RFH_GEN2_VIN_CS_KNOWN_MAGICS,RFH_GEN2_VIN_MAGIC_FORWARD,RFH_GEN2_VIN_MAGIC_REVERSED,rfhSec16Cs};
