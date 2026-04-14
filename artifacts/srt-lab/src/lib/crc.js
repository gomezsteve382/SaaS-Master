function crc16(d,i=0xFFFF){let c=i;for(let x=0;x<d.length;x++){c^=d[x]<<8;for(let j=0;j<8;j++)c=c&0x8000?(c<<1)^0x1021:c<<1;c&=0xFFFF;}return c;}
function crc8_42(d){let c=0x2E;for(let x=0;x<d.length;x++){c^=d[x];for(let j=0;j<8;j++)c=c&0x80?((c<<1)^0x42)&0xFF:(c<<1)&0xFF;}return c;}
function crc8rf(d){let c=0x54;for(let x=0;x<d.length;x++){c^=d[x];for(let j=0;j<8;j++)c=c&1?((c>>1)^0xA0):c>>1;}return c&0xFF;}

// Gen2 RFH (24C32, 4096 B) VIN checksum: XOR all 17 raw stored bytes then XOR with magic 0x87.
// VINs are stored byte-reversed in Gen2; pass the raw (reversed) bytes as stored on chip.
const RFH_GEN2_VIN_CS_MAGIC=0x87;
function rfhGen2VinCs(raw17){return Array.from(raw17).reduce((a,b)=>a^b,0)^RFH_GEN2_VIN_CS_MAGIC;}

// Gen2 RFH (24C32, 4096 B) SEC16 checksum: byte[0] = XOR(16 raw bytes) ^ 0x8B, byte[1] = 0x00.
// Returns the 2-byte big-endian CS as a single 16-bit integer (matches (data[off+16]<<8)|data[off+17]).
const RFH_SEC16_CS_MAGIC=0x8B;
function rfhSec16Cs(raw16){return((Array.from(raw16).reduce((a,b)=>a^b,0)^RFH_SEC16_CS_MAGIC)<<8)|0x00;}

export {crc16,crc8_42,crc8rf,rfhGen2VinCs,RFH_GEN2_VIN_CS_MAGIC,rfhSec16Cs,RFH_SEC16_CS_MAGIC};
