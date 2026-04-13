function crc16(d,i=0xFFFF){let c=i;for(let x=0;x<d.length;x++){c^=d[x]<<8;for(let j=0;j<8;j++)c=c&0x8000?(c<<1)^0x1021:c<<1;c&=0xFFFF;}return c;}
function crc8_42(d){let c=0x2E;for(let x=0;x<d.length;x++){c^=d[x];for(let j=0;j<8;j++)c=c&0x80?((c<<1)^0x42)&0xFF:(c<<1)&0xFF;}return c;}
function crc8rf(d){let c=0x54;for(let x=0;x<d.length;x++){c^=d[x];for(let j=0;j<8;j++)c=c&1?((c>>1)^0xA0):c>>1;}return c&0xFF;}

export {crc16,crc8_42,crc8rf};
