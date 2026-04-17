/* UDS Negative Response Code decoder — ported from reference App.jsx */
export function decodeNRC(code){
  const nrc={
    0x10:'General reject',0x11:'Service not supported',0x12:'Subfunction not supported',
    0x13:'Incorrect length',0x22:'Conditions not correct',0x24:'Sequence error',
    0x31:'Request out of range',0x33:'Security access denied',0x35:'Invalid key',
    0x36:'Exceeded attempts',0x37:'Required time delay not expired',0x78:'Response pending',
    0x7E:'Subfunction not supported in session',0x7F:'Service not supported in session',
  };
  return nrc[code]||('NRC 0x'+code.toString(16).toUpperCase());
}

export {parseVinFromResponse} from './initAdapter.js';
