/**
 * bcmConfigCategories.js — bucket every BCM Configuration DID
 * (DE00..DE0C plus the 0x04C0..0x05DF body extras) into one of ten
 * themed categories, each with a Pixar-style hero banner, accent
 * colour and short tagline used by BcmConfigTab.
 *
 * Anything not in CATEGORY_DID_MAP falls into the OTHER bucket so a
 * future generator that introduces a new DID still renders.
 */

import perfImg from '../assets/bcm-cat/perf-srt.png';
import identityImg from '../assets/bcm-cat/identity.png';
import lightingImg from '../assets/bcm-cat/lighting.png';
import doorsImg from '../assets/bcm-cat/doors.png';
import comfortImg from '../assets/bcm-cat/comfort.png';
import camerasImg from '../assets/bcm-cat/cameras.png';
import safetyImg from '../assets/bcm-cat/safety.png';
import keysImg from '../assets/bcm-cat/keys.png';
import suspImg from '../assets/bcm-cat/suspension.png';
import towingImg from '../assets/bcm-cat/towing.png';

export const BCM_CATEGORIES = [
  {
    id: 'perf',
    label: 'PERFORMANCE & SRT',
    tag: 'TRACK · DRAG · LAUNCH · TRANS BRAKE · LINE LOCK',
    accent: '#FF1744',
    image: perfImg,
    glyph: '🏁',
    blurb: 'Performance Pages, Track Mode, Drag Mode, Launch Control, Line Lock, Trans Brake, Eco/Sport/Custom drive modes.',
  },
  {
    id: 'identity',
    label: 'VEHICLE IDENTITY',
    tag: 'BRAND · CLASS · PACKAGE · MODEL YEAR',
    accent: '#FF6D00',
    image: identityImg,
    glyph: '🏷',
    blurb: 'Brand badge, vehicle class, option package, model year, fleet flag, PTO and the BCM\'s built-in vehicle profile.',
  },
  {
    id: 'lighting',
    label: 'LIGHTING & SIGNALS',
    tag: 'HEADLIGHTS · DRL · POLICE · AMBIENT',
    accent: '#FFB300',
    image: lightingImg,
    glyph: '💡',
    blurb: 'DRL, auto highbeam, fog, cornering, welcome, ambient interior lighting, hard-braking flash, police lighting.',
  },
  {
    id: 'doors',
    label: 'DOORS, LOCKS & GLASS',
    tag: 'PASSIVE ENTRY · AUTO LOCK · WINDOWS · SUNROOF',
    accent: '#2979FF',
    image: doorsImg,
    glyph: '🔒',
    blurb: 'Auto lock, passive entry, fob range, window express, sunroof / panoramic, trunk and tailgate behaviour.',
  },
  {
    id: 'comfort',
    label: 'COMFORT & CLIMATE',
    tag: 'HVAC · MIRRORS · WIPERS · DISPLAY · CHIMES',
    accent: '#00BFA5',
    image: comfortImg,
    glyph: '🛋',
    blurb: 'Heated seats, A/C, mirrors, wipers, cluster display, horn / chime volume, comfort and convenience defaults.',
  },
  {
    id: 'cameras',
    label: 'CAMERAS & VISION',
    tag: 'REAR VIEW · SURROUND · FULL CENTRAL VISION',
    accent: '#7C4DFF',
    image: camerasImg,
    glyph: '📷',
    blurb: 'Rear view camera, front / rear park assist, surround view and Full Central Vision processing presence.',
  },
  {
    id: 'safety',
    label: 'SAFETY & DRIVER ASSIST',
    tag: 'FCW · BLIND SPOT · LANE KEEP · TPMS',
    accent: '#00C853',
    image: safetyImg,
    glyph: '🛡',
    blurb: 'Forward collision warning, active blind spot, lane keep, hill-start assist, auto park, TPMS configuration.',
  },
  {
    id: 'keys',
    label: 'KEYS & SECURITY',
    tag: 'RED KEY · SKIM · SMART KEY · ALARM',
    accent: '#FF1744',
    image: keysImg,
    glyph: '🗝',
    blurb: 'Red Key feature presence, SKIM immobiliser, smart-key configuration, alarm and security wake behaviour.',
  },
  {
    id: 'suspension',
    label: 'SUSPENSION & DRIVETRAIN',
    tag: 'AIR RIDE · ACTIVE DAMPING · TRANS · PARK BRAKE',
    accent: '#AA00FF',
    image: suspImg,
    glyph: '🛞',
    blurb: 'Air Suspension Control, Active Damping, automatic transmission profile, electric park brake, engine + start.',
  },
  {
    id: 'towing',
    label: 'TOWING & ACCESSORIES',
    tag: 'HITCH · POWER LIFTGATE · TRAILER · 7-PIN',
    accent: '#FFAB00',
    image: towingImg,
    glyph: '🚛',
    blurb: 'Trailer features, tow / haul mode, power liftgate, 7-pin connector, accessory and PTO related body flags.',
  },
];

export const OTHER_CATEGORY = {
  id: 'other',
  label: 'OTHER BODY DIDs',
  tag: 'UNCATEGORISED · RAW',
  accent: '#9E9E9E',
  image: null,
  glyph: '⚙',
  blurb: 'Body parameter DIDs that have not been hand-bucketed into a themed category yet.',
};

/* DID → category id. Anything not in this map renders under OTHER. */
export const CATEGORY_DID_MAP = {
  // Performance & SRT
  0xDE0A: 'perf',
  0x0503: 'perf',
  0x04F4: 'perf',
  0x04F8: 'perf',

  // Vehicle identity
  0xDE0B: 'identity',
  0x04DE: 'identity',
  0x0504: 'identity',
  0x0536: 'identity',
  0x0538: 'identity',
  0x05B0: 'identity',
  0x05B2: 'identity',

  // Lighting & signals
  0xDE00: 'lighting',
  0x04C8: 'lighting',
  0x04C9: 'lighting',
  0x04CA: 'lighting',
  0x04DA: 'lighting',

  // Doors, locks & glass
  0xDE01: 'doors',
  0xDE05: 'doors',
  0x04D0: 'doors',
  0x04D2: 'doors',
  0x04D3: 'doors',
  0x05B1: 'doors',

  // Comfort & climate
  0xDE02: 'comfort',
  0xDE03: 'comfort',
  0xDE04: 'comfort',
  0xDE06: 'comfort',
  0xDE07: 'comfort',
  0x052B: 'comfort',
  0x052C: 'comfort',
  0x052D: 'comfort',
  0x052E: 'comfort',
  0x052F: 'comfort',

  // Cameras & vision
  0x04CC: 'cameras',
  0x052A: 'cameras',
  0x05AE: 'cameras',

  // Safety & driver assist
  0xDE0C: 'safety',
  0x04E0: 'safety',
  0x04EE: 'safety',
  0x05D6: 'safety',
  0x05D7: 'safety',

  // Keys & security
  0xDE09: 'keys',
  0x04D1: 'keys',
  0x04DB: 'keys',
  0x04DC: 'keys',
  0x04DD: 'keys',
  0x04DF: 'keys',
  0x04E4: 'keys',

  // Suspension & drivetrain
  0xDE08: 'suspension',
  0x05AC: 'suspension',
  0x05AD: 'suspension',
  0x05AF: 'suspension',

  // Towing & accessories
  0x0505: 'towing',
  0x0506: 'towing',
  0x0507: 'towing',
  0x0508: 'towing',
  0x0530: 'towing',
  0x0534: 'towing',
  0x0535: 'towing',
  0x0537: 'towing',
  0x0539: 'towing',
  0x05D4: 'towing',
};

const _byId = new Map(BCM_CATEGORIES.map((c) => [c.id, c]));

export function categoryForDid(did) {
  const id = CATEGORY_DID_MAP[did];
  if (id && _byId.has(id)) return _byId.get(id);
  return OTHER_CATEGORY;
}

/** Return [{ category, dids: number[] }] in BCM_CATEGORIES order, with OTHER appended if any unmapped DIDs. */
export function bucketDids(allDids) {
  const buckets = new Map(BCM_CATEGORIES.map((c) => [c.id, []]));
  const others = [];
  for (const did of allDids) {
    const id = CATEGORY_DID_MAP[did];
    if (id && buckets.has(id)) buckets.get(id).push(did);
    else others.push(did);
  }
  const out = BCM_CATEGORIES
    .map((c) => ({ category: c, dids: buckets.get(c.id) }))
    .filter((b) => b.dids.length > 0);
  if (others.length > 0) out.push({ category: OTHER_CATEGORY, dids: others });
  return out;
}
