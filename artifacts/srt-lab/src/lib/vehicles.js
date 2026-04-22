export const VEHICLES = {
  charger: {
    id:'charger', name:'CHARGER', full:'Dodge Charger', body:'LX · LD · WIDEBODY',
    img:'/vehicles/charger.webp', accent:'#FF6D00',
    bcmFamilies:['68525720','68525721','68277389','68277390','68396561','68396562','68309504','68309505'],
    generations:[
      {id:'lx1',label:'2011–2014 LX',years:'11-14',bcmPn:'68525720',family:'mpc5605b',sec16:'gen1-18b',vinOff:0x5308},
      {id:'lx2',label:'2015–2017 LX',years:'15-17',bcmPn:'68277389',family:'mpc5606b',sec16:'gen1-18b',vinOff:0x1308},
      {id:'lx3',label:'2018–2020 LD',years:'18-20',bcmPn:'68396561',family:'mpc5606b05b',sec16:'gen2-split',vinOff:0x1308},
      {id:'lx4',label:'2021+ Redeye',years:'21-23',bcmPn:'68525720',family:'mpc5606b05b',sec16:'gen2-split',vinOff:0x5308},
    ],
  },
  challenger: {
    id:'challenger', name:'CHALLENGER', full:'Dodge Challenger', body:'LC · COUPE',
    img:'/vehicles/challenger.webp', accent:'#D32F2F',
    bcmFamilies:['68525720','68525721','68277389','68277390','68396561','68396562','68309504','68309505'],
    generations:[
      {id:'lc1',label:'2011–2014 LC',years:'11-14',bcmPn:'68525720',family:'mpc5605b',sec16:'gen1-18b',vinOff:0x5308},
      {id:'lc2',label:'2015–2017 LC',years:'15-17',bcmPn:'68277389',family:'mpc5606b',sec16:'gen1-18b',vinOff:0x1308},
      {id:'lc3',label:'2018–2023 LC',years:'18-23',bcmPn:'68396561',family:'mpc5606b05b',sec16:'gen2-split',vinOff:0x1308},
    ],
  },
  durango: {
    id:'durango', name:'DURANGO', full:'Dodge Durango SRT', body:'WD · SUV',
    img:'/vehicles/durango.webp', accent:'#BDBDBD',
    bcmFamilies:['68525720','68525721','68277389','68277390','68396561','68396562','68309504','68309505'],
    generations:[
      {id:'wd1',label:'2011–2014 WD',years:'11-14',bcmPn:'68525720',family:'mpc5605b',sec16:'gen1-18b',vinOff:0x5308},
      {id:'wd2',label:'2015–2017 WD',years:'15-17',bcmPn:'68277389',family:'mpc5606b',sec16:'gen1-18b',vinOff:0x1308},
      {id:'wd3',label:'2018+ Hellcat',years:'18-23',bcmPn:'68396561',family:'mpc5606b05b',sec16:'gen2-split',vinOff:0x1308},
    ],
  },
  trackhawk: {
    id:'trackhawk', name:'TRACKHAWK', full:'Jeep Grand Cherokee Trackhawk', body:'WK2 · JEEP',
    img:'/vehicles/trackhawk.webp', accent:'#2979FF',
    bcmFamilies:['68354769','68354770'],
    generations:[
      {id:'wk2',label:'2018–2021 WK2',years:'18-21',bcmPn:'68354769',family:'mpc5606b',sec16:'trackhawk-no-flash',vinOff:0x1308},
    ],
  },
  trx: {
    id:'trx', name:'TRX', full:'RAM 1500 TRX', body:'DT · PICKUP',
    img:'/vehicles/trx.webp', accent:'#00BFA5',
    bcmFamilies:['68463847','68463848','68396561','68396562'],
    generations:[
      {id:'dt1',label:'2021–2024 DT',years:'21-24',bcmPn:'68463847',family:'mpc5606b05b',sec16:'gen2-split',vinOff:0x1308},
    ],
  },
};

export const VEHICLE_LIST = Object.values(VEHICLES);

export const KNOWN_BCM_PN = ['68396561','68396562','68277389','68277390','68525720','68525721','68354769','68354770','68463847','68463848','68309504','68309505'];

export const AMBIGUOUS_REDEYE_PNS = ['68525720','68525721'];

export const GEN2_YEAR_CHARS = new Set(['J','K','L','M','N','P','R','S','T']);

export function vehiclesForPartNumber(pn){
  if(typeof pn!=='string'){
    console.warn('[vehicles] vehiclesForPartNumber: expected a string pn, got '+typeof pn,pn);
  }
  return VEHICLE_LIST.filter(v=>v.bcmFamilies.includes(pn));
}

export function analyzeDumpPartNumber(bytes){
  const text=new TextDecoder('latin1').decode(bytes);
  const matches=[...text.matchAll(/68\d{6}/g)];
  const pns=[...new Set(matches.map(m=>m[0]))];
  const primary=pns.find(p=>KNOWN_BCM_PN.includes(p));
  let vinModelYearChar=null;
  for(const vm of text.matchAll(/[12345][A-HJ-NPR-Z0-9]{16}/g)){
    const yc=vm[0][9];if(/[A-HJ-NPR-Z]/.test(yc)){vinModelYearChar=yc;break;}
  }
  return{partNumbers:pns,primaryPn:primary||pns[0]||null,compatibleVehicles:primary?vehiclesForPartNumber(primary).map(v=>v.id):[],vinModelYearChar};
}

export function generationForPartNumber(vehicleId,pn,vinYearChar){
  if(typeof vehicleId!=='string'){
    console.warn('[vehicles] generationForPartNumber: expected a string vehicleId, got '+typeof vehicleId,vehicleId);
  }
  if(typeof pn!=='string'){
    console.warn('[vehicles] generationForPartNumber: expected a string pn, got '+typeof pn,pn);
  }
  const v=VEHICLES[vehicleId];if(!v)return null;
  if(AMBIGUOUS_REDEYE_PNS.includes(pn)){
    const isGen2=vinYearChar&&GEN2_YEAR_CHARS.has(String(vinYearChar).toUpperCase());
    const lookupPn='68525720';
    return v.generations.find(g=>g.bcmPn===lookupPn&&(isGen2?g.sec16==='gen2-split':g.sec16==='gen1-18b'));
  }
  return v.generations.find(g=>g.bcmPn===pn);
}
