const u32=n=>n>>>0;
function sxor(s,c){let k=u32(s);for(let i=0;i<5;i++)k=k&0x80000000?u32((k<<1)^u32(c)):u32(k<<1);return k;}
function cda6(s){let k=u32(s);k=u32(k^0x4B129F);k=u32((k<<3)|(k>>>29));k=u32(k+0x1234);k=u32(k^0xABCD);return u32((k>>>5)|(k<<27));}
const NT=[0x44,0x41,0x49,0x4D,0x4C,0x45,0x52,0x43,0x48,0x52,0x59,0x53,0x4C,0x45,0x52,0x31],NS=[0x9D9F,0xCE48,0xB0F3,0xD99B,0xA720,0xFDD6,0x836D,0x6F8E];
function ngc(s){let k=0;for(let i=0;i<4;i++){let b=(u32(s)>>(i*8))&0xFF;k=u32(k^u32(((NT[b&0xF]^NT[(b>>4)&0xF])*NS[i%8])&0xFFFFFFFF));}return k;}
const TT={a:[0x727B,0xB301,0x08EB,0xB0BA,0xECA7,0x0ECC,0xD69A,0xE47E],b:[0x7A44,0x0201,0xF123,0x146E,0xCBC2,0x553F,0xD398,0x4EDC],c:[0x22B5,0x5767,0x4C5A,0xE443,0xC606,0x7544,0x0DFB,0x36D6],d:[0x632A,0x193B,0x914F,0x0F88,0x5E51,0x8DCD,0xDD6C,0x00DD]},TM=[0xBAEE,0xE000,0x1C00,0x0380,0x0070,0x0007];
function tipm(s,t='a'){const tb=TT[t]||TT.a;let v=s&0xFFFF,k=0;for(let i=0;i<tb.length;i++){let m=v&TM[i%TM.length],b=0,x=m;while(x){b^=x&1;x>>=1;}k=(k<<1)|b;k^=tb[i];k&=0xFFFF;}return k;}

const ALGOS=[
  {id:'gpec1',n:'GPEC1',h:'670269',fn:s=>sxor(s,670269)},
  {id:'gpec2',n:'GPEC2',h:'Continental',fn:s=>sxor(s,0xE72E3799)},
  {id:'gpec2f',n:'GPEC2 Flash',h:'Flash',fn:s=>sxor(s,0x966AEEB1)},
  {id:'gpec2e',n:'GPEC2 EPROM',h:'EPROM',fn:s=>sxor(s,0x3F711F5A)},
  {id:'gpec3',n:'GPEC3',h:'2018+',fn:s=>sxor(s,0x129D657F)},
  {id:'gpec2a',n:'GPEC2A',h:'GPEC2A',fn:s=>sxor(s,0xCE853A6F)},
  {id:'gpec15',n:'GPEC2 2015',h:'2015-18',fn:s=>sxor(s,0x47EC21F8)},
  {id:'ngc',n:'NGC',h:'DAIMLERCHRYSLER',fn:s=>ngc(s)},
  {id:'jtec',n:'JTEC',h:'Fixed 0000',fn:()=>0},
  {id:'cda6',n:'CDA6',h:'BCM/ABS/IPC',fn:s=>cda6(s)},
  {id:'t80',n:'TIPM 0x80',h:'t8001',fn:s=>tipm(s,'a')},
  {id:'t36',n:'TIPM 0x36',h:'t3605',fn:s=>tipm(s,'b')},
  {id:'t81',n:'TIPM 0x81',h:'t8101',fn:s=>tipm(s,'c')},
  {id:'t3c',n:'TIPM 0x3C',h:'t3c',fn:s=>tipm(s,'d')},
];

export {u32,sxor,cda6,ngc,tipm,ALGOS};
