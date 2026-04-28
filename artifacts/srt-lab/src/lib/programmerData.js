/* Programmer-tab data tables shared by ECM/ADCM (and future Program-All).
   Algorithms ported verbatim from attached_assets/App_1776444434000.jsx. */

const u32=n=>n>>>0;

/* All security algorithms ECM auto-tries on unlock */
export const ECM_ALGOS=[
  {n:'GPEC2 (Continental)',fn:s=>{let k=u32(s);for(let i=0;i<5;i++){k=k&0x80000000?u32((k<<1)^0xE72E3799):u32(k<<1);}return k;}},
  {n:'GPEC2 Flash',fn:s=>{let k=u32(s);for(let i=0;i<5;i++){k=k&0x80000000?u32((k<<1)^0x966AEEB1):u32(k<<1);}return k;}},
  {n:'GPEC2 EPROM',fn:s=>{let k=u32(s);for(let i=0;i<5;i++){k=k&0x80000000?u32((k<<1)^0x3F711F5A):u32(k<<1);}return k;}},
  {n:'GPEC3 (2018+)',fn:s=>{let k=u32(s);for(let i=0;i<5;i++){k=k&0x80000000?u32((k<<1)^0x129D657F):u32(k<<1);}return k;}},
  {n:'GPEC2A',fn:s=>{let k=u32(s);for(let i=0;i<5;i++){k=k&0x80000000?u32((k<<1)^0xCE853A6F):u32(k<<1);}return k;}},
  {n:'GPEC2 2015',fn:s=>{let k=u32(s);for(let i=0;i<5;i++){k=k&0x80000000?u32((k<<1)^0x47EC21F8):u32(k<<1);}return k;}},
  {n:'GPEC1',fn:s=>{let k=u32(s);for(let i=0;i<5;i++){k=k&0x80000000?u32((k<<1)^670269):u32(k<<1);}return k;}},
  {n:'NGC',fn:s=>{const NT=[0x44,0x41,0x49,0x4D,0x4C,0x45,0x52,0x43,0x48,0x52,0x59,0x53,0x4C,0x45,0x52,0x31];const NS=[0x9D9F,0xCE48,0xB0F3,0xD99B,0xA720,0xFDD6,0x836D,0x6F8E];let k=0;for(let i=0;i<4;i++){let b=(u32(s)>>(i*8))&0xFF;k=u32(k^u32(((NT[b&0xF]^NT[(b>>4)&0xF])*NS[i%8])&0xFFFFFFFF));}return k;}},
  {n:'SBEC (legacy)',fn:s=>u32(s*4+0x9018)},
  {n:'JTEC',fn:()=>0},
];

export const ADCM_VARIANTS=[
  {id:'challenger_srt',     n:'Dodge Challenger SRT',          code:0x01, notes:'5.7L/6.4L HEMI'},
  {id:'challenger_hellcat', n:'Dodge Challenger Hellcat',      code:0x02, notes:'6.2L Supercharged'},
  {id:'challenger_redeye',  n:'Dodge Challenger Redeye',       code:0x03, notes:'6.2L SC 797hp'},
  {id:'challenger_demon',   n:'Dodge Challenger Demon',        code:0x04, notes:'6.2L SC 840hp drag'},
  {id:'challenger_demon170',n:'Dodge Challenger Demon 170',    code:0x05, notes:'6.2L SC 1025hp E85'},
  {id:'charger_srt',        n:'Dodge Charger SRT',             code:0x06, notes:'5.7L/6.4L HEMI sedan'},
  {id:'charger_hellcat',    n:'Dodge Charger Hellcat',         code:0x07, notes:'6.2L Supercharged sedan'},
  {id:'charger_redeye',     n:'Dodge Charger Redeye',          code:0x08, notes:'6.2L SC Redeye sedan'},
  {id:'trackhawk',          n:'Jeep Grand Cherokee Trackhawk', code:0x09, notes:'6.2L SC SUV'},
  {id:'gc_srt',             n:'Jeep Grand Cherokee SRT',       code:0x0A, notes:'6.4L HEMI SUV'},
  {id:'durango_srt',        n:'Dodge Durango SRT',             code:0x0B, notes:'6.4L HEMI 3-row'},
  {id:'durango_hellcat',    n:'Dodge Durango Hellcat',         code:0x0C, notes:'6.2L SC 3-row'},
  {id:'ram_limited',        n:'Ram 1500 Limited Air Susp',     code:0x0D, notes:'Air suspension'},
  {id:'gc_l',               n:'Jeep Grand Cherokee L',         code:0x0E, notes:'Air suspension 3-row'},
];

/* ADCM CAN candidates — pick one in the tab UI */
export const ADCM_MODULES=[
  {id:'ADCM_744',tx:0x744,rx:0x764,n:'Active Damping (744)',veh:'Charger / Challenger SRT'},
  {id:'ADCM_745',tx:0x745,rx:0x765,n:'Active Damping (745)',veh:'Hellcat / Trackhawk variant'},
  {id:'ADCM_7A8',tx:0x7A8,rx:0x7B0,n:'Active Damping (7A8)',veh:'Standard ADCM'},
  {id:'ADCM_7E4',tx:0x7E4,rx:0x7EC,n:'Active Damping (7E4)',veh:'Powertrain-side ADCM'},
  {id:'ADCM_754',tx:0x754,rx:0x75C,n:'Active Damping (754)',veh:'Legacy ADCM address'},
];

/* ──────────────────────────────────────────────────────────────────────────
 * Programmer / bench-tool brands and per-module connection-guide URLs.
 * Surfaced on the Module Sync workspace so a tech who already uses one of
 * these benches can jump straight to the wiring guide for the chip they
 * have in hand. URLs intentionally point at vendor wiki / product pages
 * rather than shopping links — these are reference / how-to links, not
 * affiliate redirects.
 * ────────────────────────────────────────────────────────────────────────── */
export const PROGRAMMERS = {
  MULTIPROG: { id: 'MULTIPROG', label: 'MULTIPROG', vendor: 'XHorse',  homeUrl: 'https://www.xhorsevvdi.com/multiprog' },
  UPA:       { id: 'UPA',       label: 'UPA',       vendor: 'UPA-USB', homeUrl: 'http://www.upa-usb.com/' },
  GODIAG:    { id: 'GODIAG',    label: 'GODIAG',    vendor: 'GoDiag',  homeUrl: 'https://www.godiag.com/' },
  OBDSTAR:   { id: 'OBDSTAR',   label: 'OBDSTAR',   vendor: 'OBDSTAR', homeUrl: 'https://en.obdstar.com/' },
};

/* Per-module Connection Guides for the LX (Charger / Challenger) workspace.
 * `chip` is the silicon family the bench actually clips onto, not the FCA
 * marketing name — that's what techs filter by when picking an adapter. */
export const MODULE_CONNECTION_GUIDES = [
  {
    module: 'BCM',
    chip:   'MPC560xB',
    label:  'BCM (MPC560xB)',
    guides: [
      { programmer: 'MULTIPROG', url: 'https://www.xhorsevvdi.com/multiprog/mpc560xb' },
      { programmer: 'UPA',       url: 'http://www.upa-usb.com/eng/adapters_mpc560xb.html' },
    ],
  },
  {
    module: 'PCM',
    chip:   'GPEC2A',
    label:  'PCM (GPEC2A)',
    guides: [
      { programmer: 'GODIAG',    url: 'https://www.godiag.com/godiag-gt107-dsg-gearbox-data-read-write-adapter.html' },
    ],
  },
  {
    module: 'RFH',
    chip:   '9S12X',
    label:  'RFH (9S12X)',
    guides: [
      { programmer: 'MULTIPROG', url: 'https://www.xhorsevvdi.com/multiprog/9s12x' },
      { programmer: 'UPA',       url: 'http://www.upa-usb.com/eng/adapters_9s12x.html' },
      { programmer: 'OBDSTAR',   url: 'https://en.obdstar.com/' },
    ],
  },
];

export {u32};
