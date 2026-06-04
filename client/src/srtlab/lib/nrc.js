export function nrcMsg(code){
  const nrc={
    0x10:'General reject',0x11:'Service not supported',0x12:'Subfunction not supported',
    0x13:'Incorrect message length or invalid format',0x14:'Response too long',
    0x21:'Busy repeat request',0x22:'Conditions not correct',0x24:'Request sequence error',
    0x31:'Request out of range',0x33:'Security access denied',
    0x34:'Authentication required (UDS 0x29)',0x35:'Invalid key',
    0x36:'Exceeded attempts',0x37:'Required time delay not expired',0x78:'Response pending',
    0x7E:'Subfunction not supported in session',0x7F:'Service not supported in session',
  };
  return nrc[code]||('NRC 0x'+code.toString(16).toUpperCase());
}

export const decodeNRC = nrcMsg;

export {parseVinFromResponse} from './initAdapter.js';
